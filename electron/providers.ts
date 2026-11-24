import fs from 'node:fs'
import path from 'node:path'
import { Cancelled } from './audio'
import { errorText, fetchRetry, sleep } from './net'
import type { AiWord } from './timed'

export type Progress = (p: { fraction?: number; message?: string }) => void

export interface TranscribeOpts { signal: AbortSignal; language?: string; prompt?: string; hint?: string; diarize?: boolean; hfToken?: string; onProgress: Progress }
export interface Transcriber {
  id: 'whisperx' | 'openai' | 'local'
  label: string
  maxChunkSec: number
  transcribe(file: string, o: TranscribeOpts): Promise<{ words: AiWord[]; language?: string }>
}

// ---------- Replicate ----------

const RAPI = 'https://api.replicate.com/v1'
const MODELS = { demucs: 'ryan5453/demucs', whisperx: 'victor-upmeet/whisperx' }

type Schema = { properties: Record<string, SchemaProp>; defs: Record<string, SchemaProp> }
type SchemaProp = { type?: string; format?: string; enum?: string[]; allOf?: { $ref: string }[]; $ref?: string; default?: unknown }

// Enum choices may be inline or behind a $ref, depending on how the model was built.
export function choices(s: Schema, name: string): string[] {
  const p = s.properties[name]
  if (!p) return []
  const ref = p.$ref ?? p.allOf?.[0]?.$ref
  return p.enum ?? (ref ? s.defs[ref.split('/').pop()!]?.enum ?? [] : [])
}

// tqdm-style progress ("43%|████") is the only real progress Replicate models report; use the latest one.
export function logProgress(logs: string): { fraction?: number; line?: string } {
  const lines = logs.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)
  const pcts = [...logs.matchAll(/(\d{1,3})%\|/g)]
  const last = pcts[pcts.length - 1]
  return { fraction: last ? Math.min(1, +last[1] / 100) : undefined, line: lines[lines.length - 1]?.slice(0, 160) }
}

export class Replicate {
  private versions = new Map<string, { id: string; schema: Schema }>()
  constructor(private token: string) {}

  private async call(p: string, init: RequestInit & { signal?: AbortSignal } = {}) {
    const res = await fetchRetry(p.startsWith('http') ? p : RAPI + p, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) } }, 4, 'Replicate')
    if (!res.ok) throw new Error(await errorText(res, 'Replicate'))
    return res.json()
  }

  async version(model: string, signal: AbortSignal) {
    if (!this.versions.has(model)) {
      const m = await this.call(`/models/${model}`, { signal })
      const v = m.latest_version
      if (!v?.id) throw new Error(`Replicate model ${model} has no published version.`)
      const comps = v.openapi_schema?.components?.schemas ?? {}
      this.versions.set(model, { id: v.id, schema: { properties: comps.Input?.properties ?? {}, defs: comps } })
    }
    return this.versions.get(model)!
  }

  async upload(file: string, signal: AbortSignal): Promise<string> {
    const size = fs.statSync(file).size
    if (size > 100 * 1024 * 1024) throw new Error('The audio is larger than the 100 MB upload limit.')
    const fd = new FormData()
    fd.append('content', new Blob([fs.readFileSync(file)], { type: file.endsWith('.flac') ? 'audio/flac' : 'audio/mpeg' }), path.basename(file))
    const r = await this.call('/files', { method: 'POST', body: fd, signal })
    const url = r.urls?.get
    if (!url) throw new Error('Replicate accepted the upload but returned no file URL.')
    return url
  }

  async run(model: string, input: Record<string, unknown>, signal: AbortSignal, onProgress: Progress): Promise<any> {
    const { id: version } = await this.version(model, signal)
    let pred = await this.call('/predictions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, input }), signal })
    const cancel = () => { fetch(`${RAPI}/predictions/${pred.id}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}` } }).catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
        onProgress(pred.status === 'starting' ? { message: 'Waiting for a GPU to start (first run can take a minute)…' } : { ...logProgress(pred.logs ?? ''), message: logProgress(pred.logs ?? '').line })
        await sleep(2000, signal)
        pred = await this.call(`/predictions/${pred.id}`, { signal })
      }
    } finally {
      signal.removeEventListener('abort', cancel)
    }
    if (signal.aborted || pred.status === 'canceled') throw new Cancelled()
    if (pred.status === 'failed') throw new Error(`The ${model.split('/')[1]} model failed: ${String(pred.error ?? 'unknown error').slice(0, 300)}`)
    return pred.output
  }

  async download(url: string, out: string, signal: AbortSignal) {
    const res = await fetchRetry(url, { signal }, 4, 'Replicate')
    if (!res.ok) throw new Error(await errorText(res, 'Replicate'))
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  }
}

// Demucs (htdemucs) two-stem separation. Input names are read from the model's published schema.
export async function separateVocals(r: Replicate, file: string, out: string, outInstrumental: string, signal: AbortSignal, onProgress: Progress) {
  const { schema } = await r.version(MODELS.demucs, signal)
  const props = Object.keys(schema.properties)
  const audioField = props.find((k) => schema.properties[k].format === 'uri') ?? 'audio'
  const input: Record<string, unknown> = {}
  for (const k of props) {
    const c = choices(schema, k)
    if (c.includes('vocals')) input[k] = 'vocals'
    else if (c.includes('htdemucs')) input[k] = 'htdemucs'
    else if (c.includes('mp3') && (c.includes('wav') || c.includes('flac'))) input[k] = 'mp3'
  }
  if (!Object.values(input).includes('vocals')) throw new Error("The Demucs model no longer offers a vocals-only option.")
  onProgress({ message: 'Uploading audio for separation…' })
  input[audioField] = await r.upload(file, signal)
  const output = await r.run(MODELS.demucs, input, signal, onProgress)
  const vocals = typeof output === 'object' && output
    ? output.vocals ?? Object.entries(output).find(([k, v]) => /vocal/i.test(k) && !/no_?vocal/i.test(k) && typeof v === 'string')?.[1]
    : undefined
  if (typeof vocals !== 'string') throw new Error('Demucs finished but returned no vocal track.')
  onProgress({ message: 'Downloading the isolated vocals…' })
  await r.download(vocals, out, signal)
  const inst = Object.entries(output as Record<string, unknown>).find(([k, v]) => /no_?vocal|instrumental|accompaniment/i.test(k) && typeof v === 'string')?.[1]
  if (typeof inst === 'string') await r.download(inst, outInstrumental, signal)
}

type WxWord = { word?: string; start?: number; end?: number; score?: number; speaker?: string }
type WxSeg = { start: number; end: number; text: string; words?: WxWord[]; speaker?: string }

export function parseWhisperX(output: { segments?: WxSeg[]; detected_language?: string }): { words: AiWord[]; language?: string } {
  const words: AiWord[] = []
  ;(output.segments ?? []).forEach((s, seg) => {
    if (s.words?.length) {
      for (const w of s.words) {
        if (!w.word?.trim()) continue
        words.push({ text: w.word.trim(), start: w.start ?? NaN, end: w.end ?? NaN, confidence: w.score ?? 0.4, speaker: w.speaker ?? s.speaker, seg })
      }
    } else if (s.text?.trim()) {
      // Unaligned segment: words get positions inside the segment only, and are marked low-confidence.
      const parts = s.text.trim().split(/\s+/)
      const step = (s.end - s.start) / parts.length
      parts.forEach((t, i) => words.push({ text: t, start: s.start + i * step, end: s.start + (i + 1) * step, confidence: 0.3, speaker: s.speaker, seg }))
    }
  })
  return { words, language: output.detected_language }
}

export const whisperX = (r: Replicate): Transcriber => ({
  id: 'whisperx',
  label: 'WhisperX large-v3 + wav2vec2 forced alignment (Replicate)',
  maxChunkSec: 1800,
  async transcribe(file, o) {
    o.onProgress({ message: 'Uploading audio for transcription…' })
    const url = await r.upload(file, o.signal)
    const input: Record<string, unknown> = { audio_file: url, align_output: true, temperature: 0, batch_size: 32 }
    if (o.language) input.language = o.language
    if (o.prompt || o.hint) input.initial_prompt = o.prompt || o.hint
    if (o.diarize && o.hfToken) Object.assign(input, { diarization: true, huggingface_access_token: o.hfToken })
    return parseWhisperX(await r.run(MODELS.whisperx, input, o.signal, o.onProgress))
  },
})

// ---------- OpenAI Whisper ----------

type OaSeg = { start: number; end: number; avg_logprob?: number; no_speech_prob?: number; text?: string }
export function parseOpenAI(r: { words?: { word: string; start: number; end: number }[]; segments?: OaSeg[]; language?: string }) {
  const segs = r.segments ?? []
  const words: AiWord[] = (r.words ?? []).map((w) => {
    const mid = (w.start + w.end) / 2
    const si = segs.findIndex((s) => mid >= s.start && mid <= s.end)
    const s = segs[si]
    // whisper-1 gives no per-word scores; segment log-probability and no-speech probability are the best signal.
    const conf = s ? Math.max(0, Math.min(1, Math.exp(s.avg_logprob ?? -1) * (1 - (s.no_speech_prob ?? 0)))) : 0.4
    return { text: w.word, start: w.start, end: w.end, confidence: conf, seg: si >= 0 ? si : undefined }
  })
  // Segments Whisper itself thinks are probably not speech are dropped.
  const noise = new Set(segs.map((s, i) => ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1 ? i : -1)).filter((i) => i >= 0))
  return { words: words.filter((w) => w.seg === undefined || !noise.has(w.seg)), language: r.language }
}

export const openAIWhisper = (key: string): Transcriber => ({
  id: 'openai',
  label: 'OpenAI Whisper (whisper-1, word timestamps)',
  maxChunkSec: 600,
  async transcribe(file, o) {
    if (fs.statSync(file).size > 25 * 1024 * 1024) throw new Error('This chunk is over OpenAI’s 25 MB limit.')
    o.onProgress({ message: 'Transcribing with Whisper…' })
    const fd = new FormData()
    fd.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/flac' }), path.basename(file))
    fd.append('model', 'whisper-1')
    fd.append('response_format', 'verbose_json')
    fd.append('timestamp_granularities[]', 'word')
    fd.append('timestamp_granularities[]', 'segment')
    fd.append('temperature', '0')
    if (o.language) fd.append('language', o.language)
    if (o.prompt || o.hint) fd.append('prompt', (o.prompt || o.hint)!.slice(-800))
    const res = await fetchRetry('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: o.signal }, 4, 'OpenAI')
    if (!res.ok) throw new Error(await errorText(res, 'OpenAI'))
    return parseOpenAI(await res.json())
  },
})

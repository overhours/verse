import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Cancelled } from './audio'
import type { Transcriber } from './providers'
import type { AiWord } from './timed'

// Free, offline transcription with whisper.cpp. Pinned files, verified by SHA-256 before use.
const ENGINE = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5907/whisper-bin-x64.zip',
  sha256: 'ecca07b277d943e9b9f4712856a144b857271a6b333104e511e1988e80db582b',
  size: 9168428,
}
const MODEL = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  size: 574041195,
}
// Ultimate Vocal Remover's MDX-Net vocal model (Kim Vocal 2), run with ONNX Runtime.
const SEP_MODEL = {
  url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx',
  sha256: 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
  size: 66759214,
}

let root = ''
export const initLocal = (userData: string) => { root = path.join(userData, 'whisper') }
const modelPath = () => path.join(root, 'ggml-large-v3-turbo-q5_0.bin')
// Optional 'Maximum accuracy' model: full Whisper large-v3 (all 32 decoder layers; turbo has 4). Better on singing and rap, ~3-4x slower.
const LARGE = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin',
  sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1',
  size: 1081140203,
}
const largePath = () => path.join(root, 'ggml-large-v3-q5_0.bin')
export const localLargeInstalled = () => fs.existsSync(largePath())
export const LOCAL_LARGE_BYTES = LARGE.size
const cliPath = () => {
  const bin = path.join(root, 'bin')
  if (!fs.existsSync(bin)) return undefined
  const hit = (fs.readdirSync(bin, { recursive: true }) as string[]).find((f) => path.basename(f).toLowerCase() === 'whisper-cli.exe')
  return hit ? path.join(bin, hit) : undefined
}
export const localInstalled = () => !!cliPath() && fs.existsSync(modelPath())
export const sepModelPath = () => path.join(root, 'Kim_Vocal_2.onnx')
export const localSeparationInstalled = () => fs.existsSync(sepModelPath())
export const localMissingBytes = () => (cliPath() ? 0 : ENGINE.size) + (fs.existsSync(modelPath()) ? 0 : MODEL.size) + (localSeparationInstalled() ? 0 : SEP_MODEL.size)

async function download(f: typeof ENGINE, out: string, signal: AbortSignal, onBytes: (n: number) => void) {
  let res: Response
  try { res = await fetch(f.url, { signal }) } catch { if (signal.aborted) throw new Cancelled(); throw new Error("can't reach the download server 📡 is your wifi ok?") }
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`)
  const hash = createHash('sha256')
  const file = fs.createWriteStream(`${out}.part`)
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      if (!file.write(chunk)) await new Promise((r) => file.once('drain', r))
      onBytes(chunk.length)
    }
  } catch (e) {
    file.destroy(); fs.rmSync(`${out}.part`, { force: true })
    if (signal.aborted) throw new Cancelled()
    throw new Error(`Download interrupted: ${(e as Error).message}`)
  }
  await new Promise<void>((r, j) => file.end((e?: Error | null) => (e ? j(e) : r())))
  if (hash.digest('hex') !== f.sha256) {
    fs.rmSync(`${out}.part`, { force: true })
    throw new Error('the download came out cursed so i deleted it 🧹 try again.')
  }
  fs.renameSync(`${out}.part`, out)
}

export async function installLocal(signal: AbortSignal, onProgress: (p: { fraction: number; message: string; total: number }) => void, o: { large?: boolean } = {}) {
  fs.mkdirSync(root, { recursive: true })
  if (o.large) {
    let got = 0, last = 0
    if (!localLargeInstalled()) await download(LARGE, largePath(), signal, (n) => { got += n; if (Date.now() - last > 150) { last = Date.now(); onProgress({ fraction: got / LARGE.size, message: 'Downloading Whisper large-v3…', total: LARGE.size }) } })
    onProgress({ fraction: 1, message: 'Ready', total: LARGE.size })
    return
  }
  const total = localMissingBytes() || 1
  let done = 0, sent = 0
  const tick = (what: string) => (n: number) => {
    done += n
    if (Date.now() - sent < 150) return // network chunks arrive far faster than the UI needs
    sent = Date.now()
    onProgress({ fraction: done / total, message: what, total })
  }
  if (!cliPath()) {
    const zip = path.join(root, 'whisper-bin-x64.zip')
    await download(ENGINE, zip, signal, tick('Downloading the whisper.cpp engine…'))
    onProgress({ fraction: done / total, message: 'Unpacking…', total })
    // Windows' own bsdtar unpacks zips; use it explicitly so another tar on PATH can't shadow it.
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    await new Promise<void>((res, rej) => spawn(tar, ['-xf', zip, '-C', bin], { windowsHide: true })
      .on('error', rej).on('close', (c) => (c === 0 ? res() : rej(new Error('Could not unpack the engine.')))))
    fs.rmSync(zip, { force: true })
    if (!cliPath()) throw new Error('The engine package did not contain whisper-cli.exe.')
  }
  if (!fs.existsSync(modelPath())) await download(MODEL, modelPath(), signal, tick('Downloading the Whisper large-v3-turbo model…'))
  if (!localSeparationInstalled()) await download(SEP_MODEL, sepModelPath(), signal, tick('Downloading the vocal separation model…'))
  onProgress({ fraction: 1, message: 'Ready', total })
}

type CppToken = { text: string; offsets?: { from: number; to: number }; p?: number; t_dtw?: number }
type CppOut = { result?: { language?: string }; transcription?: { offsets: { from: number; to: number }; text: string; tokens?: CppToken[] }[] }

// Joins whisper.cpp tokens into words: a token starting with a space begins a new word.
export function parseWhisperCpp(out: CppOut): { words: AiWord[]; language?: string } {
  const words: (AiWord & { dtw: boolean })[] = []
  ;(out.transcription ?? []).forEach((s, seg) => {
    let cur: { text: string; start: number; end: number; ps: number[]; dtw: boolean } | null = null
    const flush = () => {
      if (cur && cur.text.trim()) words.push({ text: cur.text.trim(), start: cur.start, end: cur.end, confidence: cur.ps.reduce((a, b) => a + b, 0) / (cur.ps.length || 1), seg, dtw: cur.dtw })
      cur = null
    }
    for (const t of s.tokens ?? []) {
      if (/^\[_|^<\|/.test(t.text) || !t.text) continue
      const from = (t.offsets?.from ?? s.offsets.from) / 1000, to = (t.offsets?.to ?? s.offsets.to) / 1000
      // DTW times (10 ms units) are accurate onsets; plain token offsets drift badly over instrumental intros.
      const dtw = t.t_dtw !== undefined && t.t_dtw >= 0
      const onset = dtw ? t.t_dtw! / 100 : from
      if (!cur || /^\s/.test(t.text)) { flush(); cur = { text: t.text, start: onset, end: Math.max(to, onset + 0.05), ps: [t.p ?? 0.5], dtw } }
      else { cur.text += t.text; cur.end = Math.max(cur.end, to); cur.ps.push(t.p ?? 0.5) }
    }
    flush()
  })
  // With DTW onsets, a word ends where the next begins (capped so a pause isn't swallowed).
  words.forEach((w, i) => {
    if (!w.dtw) return
    const next = words[i + 1]
    w.end = Math.max(w.start + 0.08, next ? Math.min(next.start - 0.02, w.start + 1.2) : w.start + 0.8)
  })
  return { words: words.map(({ dtw: _, ...w }) => w), language: out.result?.language }
}

export const whisperLocal = (model: 'turbo' | 'large' = 'turbo'): Transcriber => ({
  id: 'local',
  label: model === 'large' ? 'Whisper large-v3 (whisper.cpp, on this PC)' : 'Whisper large-v3-turbo (whisper.cpp, on this PC)',
  maxChunkSec: 3600,
  transcribe(file, o) {
    const cli = cliPath()
    if (!cli || !fs.existsSync(modelPath())) return Promise.reject(new Error('Download the free engine first (AI providers → Free engine).'))
    if (model === 'large' && !localLargeInstalled()) return Promise.reject(new Error('Download the Maximum accuracy model first.'))
    const base = path.join(os.tmpdir(), `verse-wcpp-${process.pid}-${Date.now()}`)
    const threads = Math.max(1, Math.min(8, os.availableParallelism() - 1))
    // DTW is silently off while flash attention is on. No -sns: it suppresses the parentheses Whisper uses for backing vocals.
    const args = ['-m', model === 'large' ? largePath() : modelPath(), '-f', file, '-l', o.language || 'auto', '-t', String(threads), '-ojf', '-of', base, '-pp',
      '-dtw', model === 'large' ? 'large.v3' : 'large.v3.turbo', '-nfa', '-bs', '5', '-bo', '5']
    // Feeding each window's text into the next is what makes Whisper loop over outros; only the short re-listen keeps a prompt.
    if (o.prompt) args.push('--prompt', o.prompt.slice(-400))
    // The song hint is re-sent with every window instead of the previous window's text.
    else if (o.hint) args.push('--prompt', o.hint, '--carry-initial-prompt', '-mc', '0')
    else args.push('-mc', '0')
    return new Promise((resolve, reject) => {
      const p = spawn(cli, args, { windowsHide: true, cwd: path.dirname(cli) })
      let err = ''
      p.stderr.on('data', (d: Buffer) => {
        const s = d.toString()
        err = (err + s).slice(-4000)
        const m = [...s.matchAll(/progress =\s*(\d+)%/g)].pop()
        if (m) o.onProgress({ fraction: +m[1] / 100, message: `Transcribing on this PC (${threads} threads)…` })
      })
      const kill = () => p.kill('SIGKILL')
      o.signal.addEventListener('abort', kill, { once: true })
      p.on('error', (e) => reject(new Error(`Could not start the local engine (${e.message}).`)))
      p.on('close', (code) => {
        o.signal.removeEventListener('abort', kill)
        const json = `${base}.json`
        try {
          if (o.signal.aborted) return reject(new Cancelled())
          if (code !== 0 || !fs.existsSync(json)) return reject(new Error(`The local engine failed: ${err.trim().split('\n').slice(-2).join(' ')}`))
          resolve(parseWhisperCpp(JSON.parse(fs.readFileSync(json, 'utf8'))))
        } catch (e) { reject(e) } finally { fs.rmSync(json, { force: true }) }
      })
    })
  },
})

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Cancelled, envelope, hashFile, pcm, PCM_RATE, probe, silences, toSeparationInput, toSpeechFlac } from './audio'
import { getKey } from './keys'
import { localInstalled, localLargeInstalled, localMissingBytes, localSeparationInstalled, sepModelPath, whisperLocal } from './local'
import { lrcToPlain } from './parse'
import { separateLocally } from './separate'
import { findLyrics } from './sources'
import { openAIWhisper, Replicate, separateVocals, Transcriber, whisperX } from './providers'
import { Alternate, applyEdits, reviewWithClaude } from './refine'
import { applyConfidence, crossCheck, ensureChronological, markQuietBacking, uncoveredVocals, validateLrc, vocalRegions } from './stages'
import {
  AiLine, AiLyrics, AiWord, alignToReference, allWords, AnalyzeOptions, buildLines, cleanWords, dropSilent, harmonizeRepeats, JobEvent,
  labelSections, lineText, planChunks, repeatGroups, snapToEnergy, StageId, STAGES, syncLyricsToAudio, tidyLines, toLrc, unclearSpans,
} from './timed'

export type { AnalyzeOptions }

export function providerStatus() {
  return {
    whisperx: !!getKey('replicate'),
    openai: !!getKey('openai'),
    local: localInstalled(),
    localLarge: localLargeInstalled(),
    separation: !!getKey('replicate') || localSeparationInstalled(),
    localSeparation: localSeparationInstalled(),
    localMissingBytes: localMissingBytes(),
    refine: true,
    claude: !!getKey('anthropic'),
    diarize: !!getKey('replicate') && !!getKey('huggingface'),
  }
}

const HOP = 0.01
const key = (o: unknown) => createHash('md5').update(JSON.stringify(o)).digest('hex').slice(0, 16)
// Whisper was trained on cleaned-up transcripts, so it tends to "correct" tryna/askin'/ain't into standard English.
// A prompt written in verbatim lyric style steers it to keep the singer's own words.
export const VERBATIM_STYLE = "Lyrics written exactly as sung, keeping the singer's own slang and dropped letters: I'm tryna, gonna, wanna, gotta, ain't, y'all, 'cause, askin', nothin', runnin'."

/*
 * Seven stages, each building on the last without undoing it:
 *  1 prepare    – read, fingerprint and convert the audio; isolate vocals; find where singing actually happens
 *  2 analyse    – transcribe the lead vocal (verbatim-style prompt, beam search, word timing)
 *  3 backing    – re-listen to vocal regions no word covers: backing vocals, ad-libs, echoes
 *  4 sync       – word timestamps: energy-snapped, chronological, no shared stamps (or: align the user's own lyrics)
 *  5 refine     – independent second listen of medium/low-confidence passages, then published lyrics, Claude and
 *                 chorus repeats; only audio evidence changes a word, everything else becomes a suggestion
 *  6 confidence – real recogniser confidence -> accept / flag for review / [unclear]
 *  7 finalise   – build lines and sections, validate the LRC, save
 */
export async function analyze(file: string, opts: AnalyzeOptions, cacheRoot: string, emit: (e: JobEvent) => void, signal: AbortSignal): Promise<AiLyrics> {
  const notes: string[] = []
  const check = () => { if (signal.aborted) throw new Cancelled() }
  const stage = (s: StageId, state: JobEvent['state'], extra: Omit<JobEvent, 'stage' | 'state'> = {}) => emit({ stage: s, state, ...extra })
  const align = opts.align

  // ---- 1. Audio and vocal sections ----
  stage('prepare', 'running', { message: 'Reading the audio file…' })
  if (!fs.existsSync(file)) throw new Error('the audio file vanished from where it was saved 🫥')
  const info = await probe(file).catch(() => { throw new Error("that's not audio, or it's broken 🥴") })
  if (!info.durationSec) throw new Error('This audio file has no playable length.')
  stage('prepare', 'running', { message: `${Math.round(info.durationSec)} s · ${info.sampleRate ?? '?'} Hz · ${info.channels ?? '?'} ch · fingerprinting…` })
  const hash = await hashFile(file)
  check()
  const dir = path.join(cacheRoot, hash.slice(0, 32))
  fs.mkdirSync(dir, { recursive: true })
  // Keys cover every setting and engine that changes the output; bump the version when processing itself changes.
  const resultKey = `result9-${key({ ...opts, claude: !!getKey('anthropic'), cloudSep: !!getKey('replicate'), localSep: localSeparationInstalled() })}.json`
  const cached = readJson<AiLyrics>(path.join(dir, resultKey))
  if (cached) {
    for (const s of STAGES) stage(s, s === 'finalise' ? 'done' : 'skipped', { message: 'Loaded from cache: this audio was already analysed with these settings.' })
    return cached
  }

  const transcriber = makeTranscriber(opts)
  const mix = path.join(dir, 'mix16k.flac')
  if (!fs.existsSync(mix)) {
    await toSpeechFlac(file, `${mix}.tmp.flac`, { signal, onTime: (t) => stage('prepare', 'running', { fraction: t / info.durationSec, message: 'Converting to 16 kHz mono for analysis…' }) })
    fs.renameSync(`${mix}.tmp.flac`, mix)
  }

  let source = mix
  let vocalsPath: string | undefined, instrumentalPath: string | undefined, sepLabel: string | undefined
  if (opts.separate) {
    const token = getKey('replicate')
    const stem = path.join(dir, token ? 'vocals.mp3' : 'vocals-mdx.mp3')
    const stem16 = stem.replace('.mp3', '16k.flac')
    const inst = path.join(dir, token ? 'instrumental.mp3' : 'instrumental-mdx.mp3')
    const part = (f: string) => f.replace('.mp3', '.part.mp3')
    let gpu = false
    try {
      if (!token && !localSeparationInstalled()) throw new Error('No vocal separation is set up.')
      if ((!fs.existsSync(stem) || !fs.existsSync(inst)) && !token) {
        const msg = 'Isolating vocals on this PC (MDX-Net)…'
        stage('prepare', 'running', { message: msg })
        gpu = await separateLocally(file, part(stem), part(inst), sepModelPath(), signal, (f) => stage('prepare', 'running', { fraction: f, message: msg }))
        fs.renameSync(part(stem), stem); fs.renameSync(part(inst), inst)
      } else if (!fs.existsSync(stem) && token) {
        stage('prepare', 'running', { message: 'Preparing audio for Demucs…' })
        const upload = path.join(dir, 'separation-input.mp3')
        if (!fs.existsSync(upload)) await toSeparationInput(file, upload, { signal })
        await separateVocals(new Replicate(token!), upload, part(stem), part(inst), signal, (p) => stage('prepare', 'running', p))
        fs.renameSync(part(stem), stem)
        if (fs.existsSync(part(inst))) fs.renameSync(part(inst), inst)
      }
      if (!fs.existsSync(stem16)) await toSpeechFlac(stem, stem16, { signal })
      source = stem16
      vocalsPath = stem
      if (fs.existsSync(inst)) instrumentalPath = inst
      sepLabel = (token ? 'Demucs htdemucs (Replicate)' : 'UVR MDX-Net Kim Vocal 2 (on this PC)') + (gpu ? ', GPU' : '')
    } catch (e) {
      if (e instanceof Cancelled) throw e
      notes.push(`Vocal separation was skipped (${(e as Error).message}): the full mix was transcribed instead.`)
    }
  }
  const isolated = source !== mix
  const env = envelope(await pcm(source, signal), PCM_RATE, HOP)
  const regions = isolated ? vocalRegions(env, HOP) : []
  const singing = regions.reduce((s, r) => s + r.end - r.start, 0)
  stage('prepare', 'done', {
    message: isolated
      ? `Vocals isolated (${sepLabel}) · ${regions.length} vocal sections, ${fmt(singing)} of singing`
      : `${fmt(info.durationSec)} · full mix (no vocal isolation)`,
  })
  check()

  // ---- 2. Lead vocal transcription ----
  const hint = `${opts.title ? `${opts.title}${opts.artist ? ` by ${opts.artist}` : ''}. ` : ''}${VERBATIM_STYLE}`
  const asrKey = path.join(dir, `asr4-${key({ t: transcriber.label, src: path.basename(source), d: opts.diarize, l: opts.language, hint })}.json`)
  let asr = readJson<{ words: AiWord[]; language?: string }>(asrKey)
  if (asr) stage('analyse', 'done', { message: 'Using the transcription from an earlier run.' })
  else {
    const chunks = planChunks(info.durationSec > transcriber.maxChunkSec ? await silences(source, signal) : [], info.durationSec, transcriber.maxChunkSec)
    const words: AiWord[] = []
    let language: string | undefined
    for (const [i, c] of chunks.entries()) {
      const part = chunks.length === 1 ? source : path.join(dir, `chunk-${i}.flac`)
      if (chunks.length > 1) await toSpeechFlac(source, part, { signal, start: c.start, end: c.end })
      const label = chunks.length > 1 ? `Part ${i + 1} of ${chunks.length}: ` : ''
      const r = await transcriber.transcribe(part, {
        signal, language: opts.language || language, diarize: opts.diarize, hint, hfToken: getKey('huggingface'),
        onProgress: (p) => stage('analyse', 'running', { fraction: (i + (p.fraction ?? 0)) / chunks.length, message: label + (p.message ?? transcriber.label) }),
      })
      language ??= r.language
      for (const w of r.words) {
        const s = w.start + c.start, e = w.end + c.start, mid = (s + e) / 2
        if (Number.isNaN(mid) || (mid >= c.keepFrom && mid < c.keepTo)) words.push({ ...w, start: s, end: e, seg: w.seg === undefined ? undefined : i * 100000 + w.seg })
      }
    }
    if (opts.diarize && !getKey('huggingface')) notes.push('Vocalist identification needs a Hugging Face token; it was skipped.')
    asr = { words, language }
    fs.writeFileSync(asrKey, JSON.stringify(asr))
    stage('analyse', 'done', { message: `${words.length} words recognised${language ? ` · language: ${language}` : ''}` })
  }
  check()
  let words = cleanWords(asr.words, info.durationSec)
  if (isolated && !align) words = dropSilent(words, env, HOP) // invented words sit over silence on the isolated vocals
  if (!words.length) throw new Error('heard zero words 🙉 might be an instrumental?')

  const relisten = async (start: number, end: number, k: string, prompt?: string) => {
    const clip = path.join(dir, `clip-${k}.flac`)
    await toSpeechFlac(source, clip, { signal, start, end })
    const r = await transcriber.transcribe(clip, { signal, language: opts.language || asr!.language, prompt, onProgress: () => {} })
    return cleanWords(r.words.map((w) => ({ ...w, start: w.start + start, end: w.end + start, seg: undefined })), info.durationSec)
  }
  const budget = transcriber.id === 'local' ? 12 : 4 // cloud passes cost money; the free engine only costs time

  // ---- 3. Backing vocals and ad-libs ----
  if (align) stage('backing', 'skipped', { message: 'Not needed when syncing your own lyrics.' })
  else if (!isolated) stage('backing', 'skipped', { message: 'Needs isolated vocals (turn on “Isolate vocals first”).' })
  else {
    const quiet = markQuietBacking(words, env, HOP, regions)
    const gaps = uncoveredVocals(regions, words).sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, budget).sort((a, b) => a.start - b.start)
    let found = 0
    for (const [k, g] of gaps.entries()) {
      stage('backing', 'running', { fraction: k / gaps.length, message: `Listening to unlabelled vocals ${k + 1} of ${gaps.length} (${fmt(g.start)})…` })
      try {
        // No lyric prompt here: it would tempt the model to repeat the lead line instead of hearing the ad-lib.
        const heard = (await relisten(Math.max(0, g.start - 0.15), Math.min(info.durationSec, g.end + 0.15), `b${k}`))
          .filter((w) => (w.start + w.end) / 2 >= g.start - 0.1 && (w.start + w.end) / 2 <= g.end + 0.1 && w.confidence >= 0.45)
        words.push(...heard.map((w) => ({ ...w, backing: true, seg: 900000 + k })))
        found += heard.length
      } catch (e) {
        if (e instanceof Cancelled) throw e
        notes.push(`Couldn't re-listen at ${fmt(g.start)}: ${(e as Error).message}`)
      }
    }
    words.sort((a, b) => a.start - b.start)
    stage('backing', 'done', { message: [quiet && `${quiet} word(s) sung well below the lead marked as backing`, gaps.length ? `${found} backing or ad-lib word(s) found in ${gaps.length} region(s) the lead transcription missed` : 'Every vocal region is covered by the transcription'].filter(Boolean).join(' · ') })
  }
  check()

  // ---- 4. Word timestamps ----
  let lines: AiLine[] | undefined
  if (align) {
    stage('sync', 'running', { message: 'Matching your lyrics to what was sung…' })
    const r = syncLyricsToAudio(align, words, info.durationSec)
    if (!r.total) throw new Error('The lyrics have no lines to sync.')
    lines = tidyLines(r.lines.map((l) => ({ ...l, words: snapToEnergy(l.words, env, HOP, isolated) })))
    const pct = Math.round((r.matched / r.total) * 100)
    if (pct < 40) notes.push(`Only ${pct}% of your lyrics were clearly heard in the audio. Check the flagged words, and that the lyrics belong to this recording.`)
    stage('sync', 'done', { message: `${r.matched} of ${r.total} of your words matched to the vocals (${pct}%) · ${lines.filter((l) => l.kind === 'vocal').length} lines` })
  } else {
    stage('sync', 'running', { message: 'Fitting word boundaries to the vocal energy…' })
    words = ensureChronological(snapToEnergy(words, env, HOP, isolated), info.durationSec)
    stage('sync', 'done', { message: `${words.length} words timed${transcriber.id === 'whisperx' ? ' (forced alignment)' : ''}, in order, none sharing a timestamp` })
  }
  check()

  // ---- 5. Correction against the audio ----
  const refinedBy: string[] = [], summary: string[] = []
  if (align) stage('refine', 'skipped', { message: 'Your own lyrics are kept exactly as written.' })
  else if (!opts.refine && !opts.useReference) stage('refine', 'skipped', { message: 'Turned off.' })
  else {
    const alternates: Alternate[] = []
    if (opts.refine) {
      // Medium and low confidence passages get an independent second listen, with the surrounding lyrics as context.
      const spans = unclearSpans(words, { durationSec: info.durationSec, below: 0.8, max: budget })
      let verified = 0, replaced = 0, restored = 0
      for (const [k, s] of spans.entries()) {
        stage('refine', 'running', { fraction: k / (spans.length + 2), message: `Re-listening to passage ${k + 1} of ${spans.length} (${fmt(s.start)}–${fmt(s.end)})…` })
        const context = words.filter((w) => w.end <= s.start && !w.backing).slice(-40).map((w) => w.text).join(' ')
        try {
          const alt = await relisten(s.start, s.end, `r${k}`, context || undefined)
          alternates.push({ span: k, start: s.start, end: s.end, words: alt })
          const r = crossCheck(words, alt, s)
          words = r.words; verified += r.verified; replaced += r.replaced; restored += r.restored
        } catch (e) {
          if (e instanceof Cancelled) throw e
          notes.push(`Second listen at ${fmt(s.start)} failed: ${(e as Error).message}`)
        }
      }
      refinedBy.push('independent second listen')
      summary.push(`${spans.length} passage(s) re-checked · ${verified} word(s) confirmed · ${replaced} corrected by the audio${restored ? ` · ${restored} restored` : ''}`)
    }
    if (opts.useReference) {
      stage('refine', 'running', { message: 'Comparing with published lyrics…' })
      let ref = opts.reference?.trim()
      let refSource = 'the lyrics in your library'
      if (!ref && opts.title) {
        try {
          const { best } = await findLyrics({ title: opts.title, artist: opts.artist ?? '', durationSec: info.durationSec })
          // A different edit of the song (radio, live) would misplace words, so only accept a close length.
          if (best && (!best.durationSec || Math.abs(best.durationSec - info.durationSec) <= 10)) {
            ref = best.plainLyrics || (best.syncedLyrics ? lrcToPlain(best.syncedLyrics) : undefined)
            refSource = best.source ?? 'LRCLIB'
          }
        } catch (e) { notes.push(`Couldn't look up published lyrics: ${(e as Error).message}`) }
      }
      if (ref) {
        const r = alignToReference(words, ref)
        if (r.used) {
          words = r.words
          refinedBy.push(`published lyrics (${refSource}) for unclear words`)
          summary.push(`${Math.round(r.ratio * 100)}% matched ${refSource} · ${r.corrected} unclear word(s) resolved`)
        } else notes.push(`Lyrics from ${refSource} only matched ${Math.round(r.ratio * 100)}% of what was heard, so they weren't used.`)
      }
    }
    check()
    lines = labelSections(buildLines(words, { durationSec: info.durationSec }))
    const claudeKey = opts.refine ? getKey('anthropic') : undefined
    if (claudeKey) {
      stage('refine', 'running', { message: 'Claude is reviewing unclear words (suggestions only unless the audio agrees)…' })
      try {
        const plan = await reviewWithClaude(claudeKey, lines, alternates, repeatGroups(lines), signal)
        const applied = applyEdits(lines, plan, alternates)
        lines = applied.lines
        refinedBy.push('Claude review (audio-checked)')
        summary.push(`${applied.changed} Claude edit(s) backed by the audio`)
      } catch (e) {
        if (e instanceof Cancelled) throw e
        notes.push(`Claude review failed and was skipped: ${(e as Error).message}`)
      }
    }
    const h = harmonizeRepeats(lines)
    lines = h.lines
    if (h.changed) summary.push(`${h.changed} unclear word(s) taken from a clearly heard repeat`)
    words = allWords(lines)
    lines = undefined
    stage('refine', 'done', { message: summary.join(' · ') || 'Nothing needed changing.' })
  }
  check()

  // ---- 6. Confidence ----
  stage('confidence', 'running', { message: 'Scoring every word…' })
  if (align) {
    const c = applyConfidence(allWords(lines!), { allowUnclear: false })
    const byWord = new Map(allWords(lines!).map((w, i) => [w, c.words[i]]))
    lines = lines!.map((l) => ({ ...l, words: l.words.map((w) => byWord.get(w) ?? w) }))
    stage('confidence', 'done', { message: `${c.counts.high} confident · ${c.counts.medium} probable · ${c.counts.low} to review` })
  } else {
    const c = applyConfidence(words, { allowUnclear: true })
    words = c.words
    stage('confidence', 'done', { message: `${c.counts.high} confident · ${c.counts.medium} probable · ${c.counts.low} to review · ${c.counts.unclear} unclear` })
  }

  // ---- 7. Lines, validation, save ----
  stage('finalise', 'running', { message: 'Building lines and validating the LRC…' })
  if (!align) lines = labelSections(buildLines(ensureChronological(words, info.durationSec), { durationSec: info.durationSec }))
  const result: AiLyrics = {
    version: 1, hash, durationSec: info.durationSec, language: asr.language, lines: lines!, notes, createdAt: Date.now(),
    providers: { separation: sepLabel, transcription: transcriber.label, refinement: align ? 'Your lyrics, aligned word by word to the transcription' : refinedBy.join('; ') || undefined },
    vocalsUrl: vocalsPath && pathToFileURL(vocalsPath).href,
    instrumentalUrl: instrumentalPath && pathToFileURL(instrumentalPath).href,
  }
  const problems = validateLrc(toLrc(result, { title: opts.title ?? '', artist: opts.artist ?? '' }))
  if (problems.length) notes.push(`LRC check: ${problems.slice(0, 3).join(' ')}`)
  fs.writeFileSync(path.join(dir, resultKey), JSON.stringify(result))
  const all = allWords(result.lines)
  stage('finalise', 'done', {
    message: `${all.length} words · ${result.lines.filter((l) => l.kind === 'vocal' && lineText(l)).length} lines · ${all.filter((w) => w.flag === 'uncertain').length} to review${problems.length ? ' · LRC issues noted' : ' · LRC valid'}`,
  })
  return result
}

function makeTranscriber(opts: AnalyzeOptions): Transcriber {
  if (opts.transcriber === 'whisperx') {
    const t = getKey('replicate')
    if (!t) throw new Error('WhisperX needs a Replicate API token. Add one in AI settings.')
    return whisperX(new Replicate(t))
  }
  if (opts.transcriber === 'local') return whisperLocal(opts.model === 'large' ? 'large' : 'turbo')
  const k = getKey('openai')
  if (!k) throw new Error('OpenAI Whisper needs an OpenAI API key. Add one in AI settings.')
  return openAIWhisper(k)
}

function readJson<T>(p: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return undefined }
}
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

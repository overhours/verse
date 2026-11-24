// Pure word-timed lyrics logic shared by the pipeline and the editor. No Node or DOM imports.

export interface AiWord {
  text: string
  start: number
  end: number
  confidence: number // 0..1
  speaker?: string
  flag?: 'uncertain' | 'corrected'
  edited?: boolean
  backing?: boolean
  seg?: number // source segment index, used as a line-break hint
  line?: number // line index in the reference lyrics, when matched against them
  verified?: boolean // two independent recognition passes heard the same word here
  alts?: string[] // other readings the evidence suggested (second pass, published lyrics, a repeat); never applied without audio support
  heard?: string // the recogniser's guess when the word is shown as [unclear]
}

export interface AiLine {
  id: string
  kind: 'vocal' | 'instrumental'
  start: number
  end: number
  words: AiWord[]
  speaker?: string
  section?: string
  backing?: boolean // every word on the line is a backing vocal or ad-lib
}

export interface AiLyrics {
  version: 1
  hash: string
  durationSec: number
  language?: string
  lines: AiLine[]
  providers: { separation?: string; transcription: string; refinement?: string }
  createdAt: number
  notes: string[]
  vocalsUrl?: string // file:// URL of the isolated vocal stem, for A/B listening
  instrumentalUrl?: string // file:// URL of the backing track without vocals, for karaoke
}

export const STAGES = ['prepare', 'analyse', 'backing', 'sync', 'refine', 'confidence', 'finalise'] as const
export type StageId = (typeof STAGES)[number]
export interface AnalyzeOptions {
  transcriber: 'whisperx' | 'openai' | 'local'; separate: boolean; refine: boolean; diarize: boolean; language: string
  useReference: boolean // check against lyrics published online when they exist
  title?: string; artist?: string; reference?: string // song details and lyrics the app already has
  align?: string // the user's own lyrics: keep this text and only find its timing in the audio
  model?: 'turbo' | 'large' // free engine model: balanced or maximum accuracy
}
export interface JobEvent {
  stage: StageId
  state: 'running' | 'done' | 'skipped'
  fraction?: number // real progress only; absent when the provider doesn't report any
  message?: string
}

export const UNCERTAIN = 0.5
let idSeq = 0
export const newId = () => `l${Date.now().toString(36)}${(idSeq++).toString(36)}`

// Whisper invents these on music and silence.
const HALLUCINATIONS = /^(thanks? (you )?for watching|subtitles? by|transcribed by|amara\.org|please subscribe|like and subscribe)/i
// What Whisper typically "hears" in silence or pure instrumentals, when it is the whole segment.
const SILENCE_PHRASES = /^(thank you( very much)?|thanks|you|bye( bye)?|music|\[music\]|♪+|\.+)[.!]*$/i

// Cleans raw ASR words: drops empties and known hallucinations, fills missing times locally, fixes ordering/overlap.
export function cleanWords(raw: AiWord[], durationSec: number): AiWord[] {
  const words = raw
    .map((w) => ({ ...w, text: w.text.replace(/["“”]/g, '').trim() })) // Whisper sometimes quotes a whole line
    .filter((w) => w.text && !/^[\p{P}\s♪♫]+$/u.test(w.text))
  // Drop hallucinated phrases (matched against the text of each source segment).
  const bySeg = new Map<number, string>()
  for (const w of words) bySeg.set(w.seg ?? -1, `${bySeg.get(w.seg ?? -1) ?? ''} ${w.text}`.trim())
  const bad = new Set([...bySeg].filter(([s, t]) => HALLUCINATIONS.test(t) || (s !== -1 && SILENCE_PHRASES.test(t))).map(([s]) => s))
  for (const s of loopSegments(words)) bad.add(s)
  const kept = words.filter((w) => !bad.has(w.seg ?? -1))

  // Words the aligner couldn't place get times from their timed neighbours, weighted by length.
  for (let i = 0; i < kept.length; i++) {
    if (Number.isFinite(kept[i].start) && Number.isFinite(kept[i].end)) continue
    let j = i
    while (j < kept.length && !(Number.isFinite(kept[j].start) && Number.isFinite(kept[j].end))) j++
    const from = i > 0 ? kept[i - 1].end : 0
    const to = j < kept.length ? kept[j].start : Math.min(durationSec, from + (j - i) * 0.4)
    const span = kept.slice(i, j)
    const total = span.reduce((s, w) => s + w.text.length, 0) || 1
    let t = from
    for (const w of span) {
      const d = ((to - from) * w.text.length) / total
      w.start = t; w.end = t + d; t += d
      w.confidence = Math.min(w.confidence, 0.3)
    }
    i = j - 1
  }

  kept.sort((a, b) => a.start - b.start)
  for (let i = 0; i < kept.length; i++) {
    const w = kept[i]
    w.start = Math.max(0, Math.min(w.start, durationSec))
    w.end = Math.max(w.start + 0.05, Math.min(w.end, durationSec || w.end))
    if (i > 0 && w.start < kept[i - 1].end) kept[i - 1].end = Math.max(kept[i - 1].start + 0.05, w.start)
    w.backing = w.backing || /^\(.*\)$|^\(|\)$/.test(w.text)
    if (w.confidence < UNCERTAIN && !w.flag) w.flag = 'uncertain'
  }
  return kept
}

// Whisper loops on fades and instrumentals: it repeats the previous line with its timings crushed together.
// A segment is a loop if it's squeezed (under 0.1 s per word) or near-repeats the previous one within half a second.
export function loopSegments(words: AiWord[]): Set<number> {
  const groups = new Map<number, AiWord[]>()
  for (const w of words) if (w.seg !== undefined) { const g = groups.get(w.seg); if (g) g.push(w); else groups.set(w.seg, [w]) }
  const loops = new Set<number>()
  let prev: { text: string; start: number } | null = null
  for (const [seg, ws] of groups) {
    if (!ws.every((w) => Number.isFinite(w.start) && Number.isFinite(w.end))) { prev = null; continue }
    const start = Math.min(...ws.map((w) => w.start)), end = Math.max(...ws.map((w) => w.end))
    const text = ws.map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')).filter(Boolean).join(' ')
    const squeezed = ws.length >= 3 && end - start < 0.1 * ws.length
    if (squeezed || (prev && start - prev.start < 0.5 && similarity(text, prev.text) >= 0.8)) { loops.add(seg); continue }
    prev = { text, start }
  }
  return loops
}

// On an isolated vocal track, a word with no vocal energy under it was invented (typically in intros, outros and gaps).
export function dropSilent(words: AiWord[], env: Float32Array, hopSec: number): AiWord[] {
  if (!env.length) return words
  const sorted = [...env].sort((a, b) => a - b)
  const thr = Math.max(sorted[Math.floor(sorted.length * 0.95)] * 0.03, 0.002) // ~-54 dBFS floor for all-silent stems
  const voiced = (a: number, b: number) => {
    let last = -1
    for (let i = Math.max(0, Math.floor(a / hopSec)); i <= Math.ceil(b / hopSec) && i < env.length; i++) if (env[i] >= thr) last = i
    return last < 0 ? null : last * hopSec
  }
  const out: AiWord[] = []
  for (const w of words) {
    if (voiced(w.start, w.end) !== null) { out.push(w); continue }
    // The last word of a phrase is often stamped just after the voice stops (a DTW quirk). If the voice ended moments
    // before, it's that word's tail, not an invented word: keep it and move it back onto the sound.
    const tail = voiced(w.start - 0.4, w.start)
    if (tail === null) continue
    const prev = out[out.length - 1]
    const end = tail + 0.04, start = Math.max(prev ? prev.start + 0.05 : 0, end - Math.min(0.3, w.end - w.start))
    if (prev && prev.end > start) prev.end = start
    out.push({ ...w, start, end: Math.max(end, start + 0.05) })
  }
  return out
}

// Tightens word boundaries to where the vocal energy actually is. env = RMS per hop of the vocal track.
export function snapToEnergy(words: AiWord[], env: Float32Array, hopSec: number, isolated = false): AiWord[] {
  if (!env.length) return words
  const sorted = [...env].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)]
  const peak = sorted[Math.floor(sorted.length * 0.95)] || 1
  const thr = floor + (peak - floor) * 0.12
  const on = (t: number) => (env[Math.min(env.length - 1, Math.max(0, Math.floor(t / hopSec)))] ?? 0) > thr
  const MIN = 0.08
  const maxLead = isolated ? 1 : 0.5 // on isolated vocals silence is real silence, so a late onset can be trusted further
  return words.map((w, i) => {
    let { start, end } = w
    // Backing vocals sit below the lead's threshold: trimming would cut into them, so only keep them in order.
    if (w.backing) { const next = words[i + 1]; if (next && end > next.start) end = next.start; return { ...w, end: Math.max(end, start + 0.05) } }
    // Trim silent tail (common: aligners stretch the last word of a phrase into the gap).
    let t = end
    while (t - hopSec > start + MIN && !on(t - hopSec)) t -= hopSec
    if (end - t > 0.15) end = Math.min(end, t + 0.04)
    // Trim silent lead.
    let s = start
    while (s + hopSec < end - MIN && !on(s) && s - start < maxLead) s += hopSec
    if (s - start > 0.1) start = s - 0.02
    // On an isolated vocal track a word that begins inside audible voice is late: walk back to the onset (never into the previous word).
    // Off on a full mix, where the instrumental keeps the energy high everywhere.
    else if (isolated) {
      const limit = Math.max(words[i - 1]?.end ?? 0, start - 0.5)
      let b = start
      while (b - hopSec > limit + 0.02 && on(b - hopSec)) b -= hopSec
      if (start - b > 0.08 && !on(b - hopSec)) start = b
    }
    const next = words[i + 1]
    if (next && end > next.start) end = next.start
    return { ...w, start, end: Math.max(end, start + 0.05) }
  })
}

export interface BuildOpts { gap?: number; maxWords?: number; instrumentalGap?: number; durationSec: number }

// Words a lyric line almost never ends on: articles, prepositions, conjunctions, subject pronouns, auxiliaries.
// (Particles like on/in/up, object pronouns and question words do end lines: 'hold on', 'I love you', 'I don't know why'.)
const NO_END = new Set(('a an the my your his her our their its to of into onto and but or nor if than because cause cuz til till while ' +
  "i we they he she i'm i've i'd i'll you're you've you'll we're we've we'll they're they've he's she's it's gonna wanna gotta tryna every such very").split(' '))
const SOFT_END = new Set('what that who where when how which whose'.split(' '))
const NO_START = new Set("me him them us myself yourself himself herself itself ourselves themselves 's n't".split(' '))
const bare = (t: string) => t.toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}']/gu, '')

// Cost of ending a line after word p, with q starting the next one. Negative = a natural break.
function breakCost(p: AiWord, q: AiWord): number {
  const pause = q.start - p.end
  let c = 2 - 3.5 * Math.min(1, Math.max(0, pause) / 1.2) // a long pause is the strongest cue in sung lyrics
  if (/[.?!…]["')\]]?$/.test(p.text)) c -= 3.5
  else if (/[,;:—–-]["')\]]?$/.test(p.text)) c -= 1
  else if (SOFT_END.has(bare(p.text))) c += pause > 1 ? 0 : 1.5 // 'close to what | I found' (but 'I don't know why' is fine)
  else if (NO_END.has(bare(p.text))) c += pause > 1.5 ? 1 : 4 // "...and | the", "my | heart": only on a real pause
  // Whisper capitalises the start of each sung line, even without punctuation ("I" is always capitalised, so it says less).
  const pw = bare(p.text)
  if (/^I('|$)/.test(q.text)) { if (!NO_END.has(pw) && !SOFT_END.has(pw) && !/[,;:]$/.test(p.text)) c -= 1.5 } // '...cared about | I wish'
  else if (/^[A-Z]/.test(q.text) && !/[,;:]$/.test(p.text)) c -= 2
  if (NO_START.has(bare(q.text))) c += 3 // '...put | me back'
  if (p.seg !== undefined && q.seg !== undefined && p.seg !== q.seg) c -= 0.5
  return c
}

// Cost of one line's shape: lyric lines are usually 4–10 words and a few seconds long.
function lineCost(ws: AiWord[], maxWords: number): number {
  const n = ws.length, dur = ws[n - 1].end - ws[0].start
  let c = 0
  if (n < 3) c += 3 - n
  if (n > 11) c += (n - 11) * 0.6
  if (n > maxWords) c += (n - maxWords) * 3
  if (dur > 7) c += (dur - 7) * 0.8
  return c
}

// Splits a run of words into lines with the lowest total cost (dynamic programming), so lines follow phrases
// instead of being cut wherever a single rule fires.
// Spelling-based rhyme key: the last vowel group and what follows ('around', 'found' → 'ound'). Function words have none.
function rhymeKey(t: string): string | undefined {
  const b = bare(t).replace(/in'$/, 'ing').replace(/'/g, '')
  if (b.length < 3 || NO_END.has(bare(t)) || SOFT_END.has(b)) return undefined
  const k = b.match(/[aeiouy]+[^aeiouy]*(?:ing|ed|es)?$/)?.[0] // the -ing/-ed/-es suffix alone isn't a rhyme
  return k && k.length >= 3 ? k : undefined
}

function splitPhrases(ws: AiWord[], maxWords: number): AiWord[][] {
  const n = ws.length, cap = Math.max(maxWords + 4, 16)
  const best = new Array<number>(n + 1).fill(Infinity), from = new Array<number>(n + 1).fill(0)
  best[0] = 0
  // Lines end on rhymes: a word that rhymes with another word nearby is a likely line end ('around' … 'found').
  const keys = ws.map((w) => rhymeKey(w.text))
  const rhymes = keys.map((k, i) => !!k && keys.some((x, j) => x === k && bare(ws[j].text) !== bare(ws[i].text) && Math.abs(i - j) >= 3 && Math.abs(i - j) <= 24))
  for (let j = 1; j <= n; j++) {
    for (let i = Math.max(0, j - cap); i < j; i++) {
      const c = best[i] + lineCost(ws.slice(i, j), maxWords) + (j < n ? breakCost(ws[j - 1], ws[j]) - (rhymes[j - 1] ? 1.5 : 0) : 0) + 1 // +1 per line: prefer fewer, fuller lines
      if (c < best[j]) { best[j] = c; from[j] = i }
    }
  }
  const out: AiWord[][] = []
  for (let j = n; j > 0; j = from[j]) out.unshift(ws.slice(from[j], j))
  return out
}

export function buildLines(words: AiWord[], o: BuildOpts): AiLine[] {
  const hardGap = Math.max(o.gap ?? 0.9, 2.5), maxWords = o.maxWords ?? 14, instr = o.instrumentalGap ?? 8
  // Hard boundaries only: a long silence, a change of singer, lead vs backing, or the user's own line breaks.
  const runs: AiWord[][] = []
  for (const w of words) {
    const cur = runs[runs.length - 1]
    const prev = cur?.[cur.length - 1]
    const brk = !prev
      || w.start - prev.end > hardGap
      || (w.speaker && prev.speaker && w.speaker !== prev.speaker)
      || !!w.backing !== !!prev.backing // backing vocals and ad-libs get their own lines
      || (w.line !== undefined && prev.line !== undefined && w.line !== prev.line)
    if (brk) runs.push([w]); else cur.push(w)
  }
  const groups = runs.flatMap((r) => (r[0].line !== undefined ? [r] : splitPhrases(r, maxWords)))
  const lines: AiLine[] = []
  const pushInstr = (start: number, end: number) => {
    if (end - start >= instr) lines.push({ id: newId(), kind: 'instrumental', start, end, words: [] })
  }
  let last = 0
  for (const g of groups) {
    pushInstr(last, g[0].start)
    const speakers = new Set(g.map((w) => w.speaker).filter(Boolean))
    lines.push({ id: newId(), kind: 'vocal', start: g[0].start, end: g[g.length - 1].end, words: g, speaker: speakers.size === 1 ? [...speakers][0] : undefined, backing: g.every((w) => w.backing) || undefined })
    last = g[g.length - 1].end
  }
  if (o.durationSec) pushInstr(last, o.durationSec)
  return lines
}

export const normLine = (l: AiLine) => l.words.map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')).filter(Boolean).join(' ')

// Labels runs of 2+ consecutive lines that recur later in the song as "Chorus".
export function labelSections(lines: AiLine[]): AiLine[] {
  const vocal = lines.filter((l) => l.kind === 'vocal')
  const count = new Map<string, number>()
  for (const l of vocal) { const k = normLine(l); if (k.split(' ').length >= 2) count.set(k, (count.get(k) ?? 0) + 1) }
  const rep = (l: AiLine) => l.kind === 'vocal' && (count.get(normLine(l)) ?? 0) >= 2
  const out = lines.map((l) => ({ ...l, section: undefined as string | undefined }))
  for (let i = 0; i < out.length; i++) {
    if (!rep(out[i])) continue
    let j = i
    while (j < out.length && rep(out[j])) j++
    if (j - i >= 2) out[i].section = 'Chorus'
    i = j - 1
  }
  return out
}

// Groups of lines whose text is identical or nearly so — candidates for chorus consistency checks.
export function repeatGroups(lines: AiLine[]): string[][] {
  const vocal = lines.filter((l) => l.kind === 'vocal' && l.words.length >= 3)
  const groups: { key: string; ids: string[] }[] = []
  for (const l of vocal) {
    const k = normLine(l)
    const g = groups.find((x) => similarity(x.key, k) >= 0.7)
    if (g) g.ids.push(l.id); else groups.push({ key: k, ids: [l.id] })
  }
  return groups.filter((g) => g.ids.length >= 2).map((g) => g.ids)
}

export function similarity(a: string, b: string): number {
  const A = a.split(' '), B = b.split(' ')
  const dp = Array.from({ length: A.length + 1 }, (_, i) => [i, ...Array(B.length).fill(0)])
  for (let j = 1; j <= B.length; j++) dp[0][j] = j
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1))
  return 1 - dp[A.length][B.length] / Math.max(A.length, B.length, 1)
}

export const lineText = (l: AiLine) => l.kind === 'instrumental' ? '' : l.words.map((w) => w.text).join(' ')
export const allWords = (lines: AiLine[]) => lines.flatMap((l) => l.words)

// Recomputes line bounds after word edits; drops vocal lines left empty.
export function tidyLines(lines: AiLine[]): AiLine[] {
  return lines
    .map((l) => {
      if (l.kind === 'instrumental' || !l.words.length) return l
      const words = [...l.words].sort((a, b) => a.start - b.start)
      return { ...l, words, start: words[0].start, end: Math.max(...words.map((w) => w.end)) }
    })
    .filter((l) => l.kind === 'instrumental' || l.words.length)
    .sort((a, b) => a.start - b.start)
}

// Spans of low-confidence words worth a second listen, padded and merged.
export function unclearSpans(words: AiWord[], o: { max?: number; pad?: number; maxLen?: number; durationSec: number; below?: number }) {
  const pad = o.pad ?? 1, maxLen = o.maxLen ?? 30, below = o.below ?? 0.55
  const spans: { start: number; end: number; n: number }[] = []
  for (const w of words) {
    if (w.confidence >= below || w.verified || w.edited) continue
    const s = Math.max(0, w.start - pad), e = Math.min(o.durationSec, w.end + pad)
    const last = spans[spans.length - 1]
    if (last && s <= last.end + 1 && e - last.start <= maxLen) { last.end = Math.max(last.end, e); last.n++ }
    else spans.push({ start: s, end: e, n: 1 })
  }
  return spans.sort((a, b) => b.n - a.n).slice(0, o.max ?? 6).sort((a, b) => a.start - b.start)
}

// Splits long audio at silences so no chunk exceeds maxLen; hard cuts (no silence) overlap so words aren't lost.
export function planChunks(silences: { start: number; end: number }[], durationSec: number, maxLen = 600, overlap = 2) {
  // [start,end] is the audio sent; words whose midpoint falls in [keepFrom,keepTo) are kept.
  const chunks: { start: number; end: number; keepFrom: number; keepTo: number }[] = []
  let start = 0, keepFrom = 0
  while (durationSec - keepFrom > maxLen) {
    const target = keepFrom + maxLen
    const mids = silences.map((s) => (s.start + s.end) / 2).filter((m) => m > keepFrom + maxLen * 0.5 && m <= target)
    if (mids.length) {
      const cut = mids[mids.length - 1]
      chunks.push({ start, end: cut, keepFrom, keepTo: cut })
      start = keepFrom = cut
    } else {
      chunks.push({ start, end: Math.min(durationSec, target + overlap), keepFrom, keepTo: target })
      keepFrom = target
      start = target - overlap
    }
  }
  chunks.push({ start, end: durationSec, keepFrom, keepTo: durationSec })
  return chunks
}

// ---------- exports ----------

const cs = (t: number) => Math.max(0, Math.round(t * 100))
export function lrcTime(t: number) {
  const c = cs(t), m = Math.floor(c / 6000), s = Math.floor((c % 6000) / 100), h = c % 100
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(h).padStart(2, '0')}`
}
export function srtTime(t: number) {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}

export interface Meta { title: string; artist: string; album?: string }
const header = (m: Meta, d: number) => [`[ti:${m.title}]`, m.artist && `[ar:${m.artist}]`, m.album && `[al:${m.album}]`, `[length:${lrcTime(d).slice(0, 5)}]`, '[re:Verse AI reconstruction]'].filter(Boolean).join('\n')

// Backing-only lines are written in parentheses, the usual lyric convention for secondary vocals.
const lrcLine = (l: AiLine) => { const t = lineText(l); return l.backing && t && !t.startsWith('(') ? `(${t})` : t }
export function toLrc(ai: AiLyrics, m: Meta) {
  return `${header(m, ai.durationSec)}\n${ai.lines.map((l) => `[${lrcTime(l.start)}]${lrcLine(l)}`).join('\n')}\n`
}
export function toEnhancedLrc(ai: AiLyrics, m: Meta) {
  const body = ai.lines.map((l) => l.kind === 'instrumental' ? `[${lrcTime(l.start)}]`
    : `[${lrcTime(l.start)}] ${l.words.map((w) => `<${lrcTime(w.start)}> ${w.text}`).join(' ')} <${lrcTime(l.end)}>`)
  return `${header(m, ai.durationSec)}\n${body.join('\n')}\n`
}
export function toSrt(ai: AiLyrics) {
  return ai.lines.filter((l) => l.kind === 'vocal').map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${lineText(l)}\n`).join('\n')
}
export function toTxt(ai: AiLyrics) {
  const out: string[] = []
  for (const l of ai.lines) {
    if (l.section && out.length) out.push('')
    out.push(l.kind === 'instrumental' ? '[Instrumental]' : lineText(l))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
}
export function toJson(ai: AiLyrics, m: Meta) {
  return JSON.stringify({
    title: m.title, artist: m.artist, durationSec: ai.durationSec, language: ai.language, providers: ai.providers, createdAt: new Date(ai.createdAt).toISOString(),
    lines: ai.lines.map((l) => ({
      kind: l.kind, start: +l.start.toFixed(3), end: +l.end.toFixed(3), section: l.section ?? null, speaker: l.speaker ?? null, text: lineText(l),
      words: l.words.map((w) => ({ text: w.text, start: +w.start.toFixed(3), end: +w.end.toFixed(3), confidence: +w.confidence.toFixed(3), speaker: w.speaker ?? null, uncertain: w.flag === 'uncertain', corrected: w.flag === 'corrected', edited: !!w.edited, backing: !!w.backing })),
    })),
  }, null, 2)
}

// ---------- alignment: against published lyrics, and between chorus repeats ----------

export const withAlt = (alts: string[] | undefined, t: string) => (alts?.some((a) => tok(a) === tok(t)) ? alts : [...(alts ?? []), t])
export const tok = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

function charSim(a: string, b: string) {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1) } return m }
  const A = grams(a), B = grams(b)
  let inter = 0
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0)
  return (2 * inter) / (a.length + b.length - 2)
}

// Needleman–Wunsch over word tokens. Returns aligned index pairs; -1 marks a gap. Similar-sounding spellings substitute cheaply.
export function alignWords(a: string[], b: string[]): { a: number; b: number }[] {
  const n = a.length, m = b.length, W = m + 1
  const cost = new Float32Array((n + 1) * W), bt = new Uint8Array((n + 1) * W)
  for (let i = 1; i <= n; i++) { cost[i * W] = i; bt[i * W] = 1 }
  for (let j = 1; j <= m; j++) { cost[j] = j; bt[j] = 2 }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const sub = a[i - 1] === b[j - 1] ? 0 : 0.4 + 0.9 * (1 - charSim(a[i - 1], b[j - 1]))
    const d = cost[(i - 1) * W + j - 1] + sub, u = cost[(i - 1) * W + j] + 1, l = cost[i * W + j - 1] + 1
    if (d <= u && d <= l) { cost[i * W + j] = d; bt[i * W + j] = 0 }
    else if (u <= l) { cost[i * W + j] = u; bt[i * W + j] = 1 }
    else { cost[i * W + j] = l; bt[i * W + j] = 2 }
  }
  const out: { a: number; b: number }[] = []
  for (let i = n, j = m; i > 0 || j > 0;) {
    const k = bt[i * W + j]
    if (i > 0 && j > 0 && k === 0) out.push({ a: --i, b: --j })
    else if (i > 0 && (k === 1 || j === 0)) out.push({ a: --i, b: -1 })
    else out.push({ a: -1, b: --j })
  }
  return out.reverse()
}

// Corrects recognised words against published lyrics while keeping the audio timing. Rejects a reference that doesn't fit.
export function alignToReference(words: AiWord[], refText: string) {
  const ref: { text: string; line: number }[] = []
  refText.split(/\r?\n/).forEach((l, line) => {
    if (/^\s*[[(].*[\])]\s*$/.test(l)) return // section labels like [Chorus]
    for (const t of l.trim().split(/\s+/)) if (tok(t)) ref.push({ text: t, line })
  })
  const pairs = alignWords(words.map((w) => tok(w.text)), ref.map((r) => tok(r.text)))
  const same = (k: number) => { const p = pairs[k]; return !!p && p.a >= 0 && p.b >= 0 && tok(words[p.a].text) === tok(ref[p.b].text) }
  const matched = pairs.filter((_, k) => same(k)).length
  const ratio = words.length ? matched / words.length : 0
  if (!ref.length || ratio < 0.45) return { words, used: false, ratio, corrected: 0, inserted: 0 }

  const out: AiWord[] = []
  let corrected = 0, inserted = 0
  for (let k = 0; k < pairs.length; k++) {
    const p = pairs[k]
    if (p.a >= 0 && p.b >= 0) {
      const w = words[p.a], r = ref[p.b]
      if (same(k)) out.push({ ...w, text: r.text, line: r.line, confidence: Math.max(w.confidence, 0.95), flag: w.flag === 'uncertain' ? undefined : w.flag })
      // The published text may only replace a word the recogniser was unsure of, next to a confirmed match.
      // A clearly heard word wins (the published lyrics can be wrong, or the performance differs); their reading is kept as a suggestion.
      else if ((same(k - 1) || same(k + 1)) && w.confidence < 0.6) { out.push({ ...w, text: r.text, line: r.line, flag: 'corrected', confidence: Math.max(w.confidence, 0.6), alts: withAlt(w.alts, w.text) }); corrected++ }
      else out.push({ ...w, line: r.line, flag: w.confidence >= 0.8 ? w.flag : 'uncertain', alts: withAlt(w.alts, r.text) })
    } else if (p.a >= 0) {
      const w = words[p.a]
      out.push(w.backing ? w : { ...w, flag: 'uncertain' }) // heard but not in the published lyrics: ad-lib or mishearing
    } else {
      let e = k
      while (e < pairs.length && pairs[e].a < 0) e++
      const prev = out[out.length - 1], next = pairs[e]
      // Missed words are only restored inside a short gap between confirmed words, so their timing is local.
      // Only between two exactly matching words: next to a word the singer changed, the different wording explains the gap.
      if (e - k <= 3 && prev && next && same(k - 1) && same(e)) {
        const nextStart = words[next.a].start
        let from = prev.end
        if (nextStart - from < 0.12 * (e - k)) { from = Math.max(prev.start + 0.05, nextStart - 0.15 * (e - k)); prev.end = from }
        const run = pairs.slice(k, e).map((q) => ref[q.b])
        const total = run.reduce((s, r) => s + r.text.length, 0)
        let t = from
        for (const r of run) {
          const d = ((nextStart - from) * r.text.length) / total
          // Not heard by the recogniser: shown for review, with a guessed position, never as confirmed.
          out.push({ text: r.text, start: t, end: t + d, confidence: 0.35, flag: 'uncertain', line: r.line, seg: prev.seg, speaker: prev.speaker })
          t += d; inserted++
        }
      }
      k = e - 1
    }
  }
  return { words: out, used: true, ratio, corrected, inserted }
}

// Free chorus consistency: in each group of repeated lines, a shaky word takes the reading of the most confident repeat.
export function harmonizeRepeats(lines: AiLine[]): { lines: AiLine[]; changed: number } {
  const byId = new Map(lines.map((l) => [l.id, l]))
  const patched = new Map<string, AiWord[]>()
  let changed = 0
  // Anchor on the best-evidenced performance: most words verified by two passes, then highest confidence.
  const score = (l: AiLine) => l.words.filter((w) => w.verified).length * 10 + l.words.reduce((s, w) => s + w.confidence, 0) / (l.words.length || 1)
  for (const ids of repeatGroups(lines)) {
    const group = ids.map((id) => byId.get(id)!)
    const anchor = group.reduce((a, b) => (score(b) > score(a) ? b : a))
    for (const l of group) {
      if (l === anchor) continue
      const ws = [...l.words]
      for (const p of alignWords(ws.map((w) => tok(w.text)), anchor.words.map((w) => tok(w.text)))) {
        if (p.a < 0 || p.b < 0) continue
        const w = ws[p.a], aw = anchor.words[p.b]
        if (tok(w.text) === tok(aw.text) || w.backing || aw.backing) continue // backing vocals vary between repeats
        // Only an unclear word borrows a clearly heard repeat; a confidently heard difference is a real variation and stays.
        if (w.confidence < 0.5 && aw.confidence >= 0.8) { ws[p.a] = { ...w, text: aw.text, flag: 'corrected', confidence: 0.5, alts: withAlt(w.alts, w.text) }; changed++ }
        else ws[p.a] = { ...w, alts: withAlt(w.alts, aw.text) }
      }
      patched.set(l.id, ws)
    }
  }
  return { lines: lines.map((l) => (patched.has(l.id) ? { ...l, words: patched.get(l.id)! } : l)), changed }
}

// ---------- tap-to-sync ----------

// Spreads a line's words between start and end, weighted by word length (longer words take longer to sing).
export function retimeLine(l: AiLine, start: number, end: number): AiLine {
  if (l.kind !== 'vocal' || !l.words.length) return { ...l, start, end }
  const span = Math.max(0.1 * l.words.length, end - start)
  const total = l.words.reduce((s, w) => s + w.text.length + 1, 0)
  let t = start
  const words = l.words.map((w) => {
    const d = (span * (w.text.length + 1)) / total
    const nw: AiWord = { ...w, start: t, end: t + d * 0.92, edited: true }
    t += d
    return nw
  })
  return { ...l, start, end: words[words.length - 1].end, words }
}

// Editable timed lyrics from existing lyrics. Synced lines keep their times; plain text gets placeholder times
// that are flagged uncertain until the lines are tapped in.
export function fromLyrics(lines: { time?: number; text: string }[], durationSec: number, hash: string): AiLyrics {
  const src = lines.filter((l) => l.text.trim() && !/^\s*[[(].*[\])]\s*$/.test(l.text))
  const timed = src.every((l) => l.time !== undefined)
  const step = durationSec / (src.length + 1)
  const out: AiLine[] = src.map((l, i) => {
    const start = timed ? l.time! : step * (i + 0.5)
    const next = timed ? src[i + 1]?.time ?? Math.min(durationSec, start + 4) : start + step
    const words = l.text.trim().split(/\s+/).map((text) => ({ text, start, end: start, confidence: timed ? 0.8 : 0.2, flag: timed ? undefined : ('uncertain' as const) }))
    return retimeLine({ id: newId(), kind: 'vocal', start, end: next, words }, start, Math.max(start + 0.3, next - 0.1))
  })
  return {
    version: 1, hash, durationSec, lines: labelSections(out), createdAt: Date.now(), notes: [],
    providers: { transcription: timed ? 'Line timestamps (word timing estimated)' : 'Manual timing (tap-to-sync)' },
  }
}

// One tap: `index` (a vocal line) starts at t; the previous tapped line ends just before t; later lines keep their
// order by moving after t with their current lengths.
export function tapLine(lines: AiLine[], index: number, t: number): AiLine[] {
  const vocal = lines.filter((l) => l.kind === 'vocal')
  const cur = vocal[index]
  if (!cur) return lines
  const prev = vocal[index - 1]
  const out = new Map<string, AiLine>()
  if (prev && prev.start < t) out.set(prev.id, retimeLine(prev, prev.start, t - 0.05))
  const curLen = Math.max(0.8, cur.end - cur.start)
  out.set(cur.id, { ...retimeLine(cur, t, t + curLen), words: retimeLine(cur, t, t + curLen).words.map((w) => ({ ...w, flag: undefined, confidence: Math.max(w.confidence, 0.7) })) })
  let after = t + curLen + 0.1
  for (const l of vocal.slice(index + 1)) {
    if (l.start >= after) break // already later: leave untouched
    const len = Math.max(0.8, l.end - l.start)
    out.set(l.id, retimeLine(l, after, after + len))
    after += len + 0.1
  }
  return lines.map((l) => out.get(l.id) ?? l)
}

// ---------- syncing the user's own lyrics to the audio ----------

const SECTION = /^\s*[[(]\s*([^\])]{1,40})\s*[\])]\s*$/

// Times the user's lyrics from what was actually heard: their words are sequence-aligned to the transcribed words
// (so order, repeats and choruses are respected) and take those words' audio timestamps. The user's text is kept exactly.
// Words the recogniser didn't catch are placed between their timed neighbours and flagged for review.
export function syncLyricsToAudio(text: string, heard: AiWord[], durationSec: number): { lines: AiLine[]; matched: number; total: number } {
  const lines: AiLine[] = []
  let section: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(SECTION)
    if (m) { section = m[1].trim(); continue }
    const parts = raw.trim().split(/\s+/).filter(Boolean)
    if (!parts.length) continue
    lines.push({ id: newId(), kind: 'vocal', start: 0, end: 0, section, words: parts.map((t) => ({ text: t, start: NaN, end: NaN, confidence: 0 })) })
    section = undefined
  }
  const mine = lines.flatMap((l) => l.words)
  if (!mine.length) return { lines: [], matched: 0, total: 0 }

  let matched = 0
  for (const p of alignWords(mine.map((w) => tok(w.text)), heard.map((w) => tok(w.text)))) {
    if (p.a < 0 || p.b < 0) continue
    const w = mine[p.a], h = heard[p.b]
    const exact = tok(w.text) === tok(h.text)
    // Exact matches are anchors; a substitution in the aligned path is the same spot misheard, so its timing is still good.
    Object.assign(w, { start: h.start, end: h.end, speaker: h.speaker, confidence: exact ? Math.max(h.confidence, 0.6) : Math.min(h.confidence, 0.45) })
    if (exact) matched++
  }

  // Fill words with no audio match from their timed neighbours.
  for (let i = 0; i < mine.length; i++) {
    if (Number.isFinite(mine[i].start)) continue
    let j = i
    while (j < mine.length && !Number.isFinite(mine[j].start)) j++
    const prevEnd = i > 0 ? mine[i - 1].end : undefined, nextStart = j < mine.length ? mine[j].start : undefined
    const run = mine.slice(i, j), len = run.reduce((s, w) => s + w.text.length + 1, 0)
    const want = Math.min(0.35 * run.length + len * 0.04, 6) // natural singing pace for the missing words
    let from: number, to: number
    if (prevEnd === undefined && nextStart === undefined) { from = 0; to = Math.min(durationSec, want) }
    else if (prevEnd === undefined) { to = nextStart!; from = Math.max(0, to - want) }
    else if (nextStart === undefined) { from = prevEnd; to = Math.min(durationSec || from + want, from + want) }
    else { from = prevEnd; to = Math.min(nextStart, prevEnd + Math.max(want, 0.12 * run.length)) }
    let t = from
    for (const w of run) {
      const d = ((to - from) * (w.text.length + 1)) / len
      Object.assign(w, { start: t, end: t + d * 0.92, confidence: 0.2, flag: 'uncertain' as const })
      t += d
    }
    i = j - 1
  }

  // Keep times moving forward and every word audible.
  for (let i = 0; i < mine.length; i++) {
    const w = mine[i], prev = mine[i - 1]
    if (prev && w.start < prev.start) w.start = prev.start + 0.01
    if (w.end <= w.start) w.end = w.start + 0.08
    if (prev && prev.end > w.start) prev.end = Math.max(prev.start + 0.05, w.start)
    if (w.confidence < UNCERTAIN && !w.flag) w.flag = 'uncertain'
  }
  for (const l of lines) { l.start = l.words[0].start; l.end = l.words[l.words.length - 1].end }

  const out: AiLine[] = []
  const gap = (s: number, e: number) => { if (e - s >= 8) out.push({ id: newId(), kind: 'instrumental', start: s, end: e, words: [] }) }
  lines.forEach((l, i) => { gap(i ? lines[i - 1].end : 0, l.start); out.push(l) })
  if (durationSec) gap(lines[lines.length - 1].end, durationSec)
  const hasSections = lines.some((l) => l.section)
  return { lines: hasSections ? out : labelSections(out), matched, total: mine.length }
}

// An honest estimate of how accurate a transcript is. It can't know the true lyrics, so it combines what is known:
// the recogniser's own confidence per word, words a person checked (count as right), [unclear] words (count as wrong),
// and, when published lyrics exist, how much of them the transcript agrees with word for word.
export interface AccuracyScore {
  score: number // 0-100, estimated share of words that are right
  words: number; checked: number; heardTwice: number; toReview: number; unclear: number
  reference?: number // 0-100 agreement with the published lyrics, when there are any
}
export function accuracyScore(lines: AiLine[], reference?: string): AccuracyScore {
  const ws = lines.flatMap((l) => l.words)
  let sum = 0, checked = 0, heardTwice = 0, toReview = 0, unclear = 0
  for (const w of ws) {
    if (w.text === '[unclear]') { unclear++; toReview++; continue }
    if (w.edited) { checked++; sum += 1; continue }
    sum += Math.max(0, Math.min(1, w.confidence))
    if (w.verified) heardTwice++
    if (w.flag === 'uncertain') toReview++
  }
  const out: AccuracyScore = { score: ws.length ? Math.round((sum / ws.length) * 100) : 0, words: ws.length, checked, heardTwice, toReview, unclear }
  const ref = (reference ?? '').split('\n').filter((l) => !/^\s*[[(].*[\])]\s*$/.test(l)).join(' ').split(/\s+/).map(tok).filter(Boolean)
  const mine = lines.filter((l) => !l.backing).flatMap((l) => l.words).filter((w) => !w.backing).map((w) => tok(w.text)).filter(Boolean) // published lyrics rarely include ad-libs
  if (ref.length >= 10 && mine.length) {
    const matched = alignWords(mine, ref).filter((p) => p.a >= 0 && p.b >= 0 && mine[p.a] === ref[p.b]).length
    out.reference = Math.round(((2 * matched) / (mine.length + ref.length)) * 100) // F1: penalises both missing and extra words
  }
  return out
}

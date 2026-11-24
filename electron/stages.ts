// Pure, independently testable logic for the transcription pipeline's later stages. No Node or DOM imports.
// Principle throughout: what was heard wins. Context, published lyrics and repeats may suggest (stored in `alts`),
// but only audio evidence (a recognition pass) may change a word.

import { AiWord, alignWords, lrcTime, tok, UNCERTAIN } from './timed'

export const TIER = { high: 0.8, low: UNCERTAIN, unclear: 0.2 } as const
export const UNCLEAR = '[unclear]'

const addAlt = (w: AiWord, t: string) => (tok(t) && tok(t) !== tok(w.text) && !w.alts?.some((a) => tok(a) === tok(t)) ? [...(w.alts ?? []), t] : w.alts)
const mid = (w: AiWord) => (w.start + w.end) / 2

// Stage 1: where the isolated vocal track actually has singing (regions above the energy threshold, at least `minLen` long).
export function vocalRegions(env: Float32Array, hopSec: number, minLen = 0.3): { start: number; end: number }[] {
  if (!env.length) return []
  const sorted = [...env].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)], peak = sorted[Math.floor(sorted.length * 0.95)]
  const thr = Math.max(floor + (peak - floor) * 0.12, 0.002)
  const out: { start: number; end: number }[] = []
  let s = -1, quiet = 0
  for (let i = 0; i <= env.length; i++) {
    const on = i < env.length && env[i] > thr
    if (on) { if (s < 0) s = i; quiet = 0 }
    else if (s >= 0 && ++quiet * hopSec > 0.25) { // bridge breaths shorter than 250 ms
      const e = i - quiet + 1
      if ((e - s) * hopSec >= minLen) out.push({ start: s * hopSec, end: e * hopSec })
      s = -1; quiet = 0
    }
  }
  return out
}

// Stage 3: vocal regions no transcribed word covers. These are where missed backing vocals and ad-libs live.
// Stage 3: a phrase sung far quieter than the lead phrases around it is a backing vocal or ad-lib.
// Measured on the isolated vocal track; returns how many words were marked.
// Phrases are the vocal sections found in the energy: word end times can't be trusted before timing is tightened.
export function markQuietBacking(words: AiWord[], env: Float32Array, hopSec: number, regions: { start: number; end: number }[], ratio = 0.5, near = 15) {
  const peak = (w: AiWord) => { let m = 0; for (let i = Math.floor(w.start / hopSec); i <= Math.ceil(w.end / hopSec) && i < env.length; i++) m = Math.max(m, env[i]); return m }
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0 }
  const groups = new Map<number, AiWord[]>()
  let run = -1, prev: AiWord | undefined
  for (const w of words) {
    // A word starting in the decay just after a section belongs to it. Words in no section (too quiet to form one)
    // are grouped with their unsectioned neighbours.
    let r = regions.length - 1
    while (r >= 0 && regions[r].start > w.start + 0.15) r--
    let k: number
    if (r >= 0 && w.start <= regions[r].end + 0.4) k = r
    else { if (!(prev && groups.get(run)?.includes(prev) && w.start - prev.start < 1)) run--; k = run }
    groups.set(k, [...(groups.get(k) ?? []), w])
    prev = w
  }
  const phrases = [...groups.values()]
  const loud = phrases.map((p) => median(p.map(peak)))
  let marked = 0
  phrases.forEach((p, i) => {
    const t = p[0].start
    const others = loud.filter((_, j) => j !== i && Math.abs(phrases[j][0].start - t) <= near)
    if (others.length < 2 || loud[i] >= ratio * median(others)) return
    for (const w of p) if (!w.backing) { w.backing = true; marked++ }
  })
  return marked
}

export function uncoveredVocals(regions: { start: number; end: number }[], words: AiWord[], margin = 0.15, minLen = 0.4) {
  const out: { start: number; end: number }[] = []
  for (const r of regions) {
    let cursor = r.start
    for (const w of words.filter((x) => x.end + margin > r.start && x.start - margin < r.end).sort((a, b) => a.start - b.start)) {
      if (w.start - margin - cursor >= minLen) out.push({ start: cursor, end: w.start - margin })
      cursor = Math.max(cursor, w.end + margin)
    }
    if (r.end - cursor >= minLen) out.push({ start: cursor, end: r.end })
  }
  return out
}

// Stage 5: merges an independent second recognition pass over [start, end] into the first, word by word.
// Agreement is real evidence, so confidence rises and the word is marked verified. Disagreement keeps the
// reading the recogniser was clearly more confident in (by `margin`) and flags it; the other reading is kept as an alt.
export function crossCheck(words: AiWord[], alt: AiWord[], span: { start: number; end: number }, margin = 0.15) {
  const inWin = (w: AiWord) => mid(w) >= span.start + 0.2 && mid(w) <= span.end - 0.2 // clip edges cut words in half
  const a = words.filter(inWin), b = alt.filter(inWin)
  const merged: AiWord[] = []
  let verified = 0, replaced = 0, restored = 0, dropped = 0
  const confidentB = b.length > 0 && b.reduce((t, w) => t + w.confidence, 0) / b.length >= 0.75
  for (const p of alignWords(a.map((w) => tok(w.text)), b.map((w) => tok(w.text)))) {
    const x = p.a >= 0 ? a[p.a] : undefined, y = p.b >= 0 ? b[p.b] : undefined
    if (x && y && tok(x.text) === tok(y.text)) {
      merged.push({ ...x, confidence: 1 - (1 - x.confidence) * (1 - y.confidence), verified: true, flag: x.flag === 'uncertain' ? undefined : x.flag })
      verified++
    } else if (x && y) {
      if (y.confidence > x.confidence + margin) {
        merged.push({ ...x, text: y.text, start: y.start, end: y.end, confidence: y.confidence, flag: 'corrected', alts: addAlt({ ...y }, x.text), backing: x.backing || y.backing })
        replaced++
      } else merged.push({ ...x, flag: 'uncertain', alts: addAlt(x, y.text) })
    } else if (x) {
      // The second pass heard nothing here. If it was confident about this passage and the first pass wasn't sure of
      // this word, the word is most likely an artefact; otherwise there's no new evidence either way.
      if (x.confidence < 0.5 && confidentB) { dropped++; continue }
      merged.push(x)
    }
    else if (y && y.confidence >= 0.7) { merged.push({ ...y, flag: y.confidence >= 0.85 ? 'corrected' : 'uncertain' }); restored++ } // a confidently heard word the first pass missed
  }
  const rest = words.filter((w) => !inWin(w))
  return { words: [...rest, ...merged].sort((p, q) => p.start - q.start), verified, replaced, restored, dropped }
}

// Stage 6: turns real recogniser confidence into actions. Very low, unconfirmed words are shown as [unclear]
// (the guess is kept in `heard`) instead of being presented as lyrics.
export function applyConfidence(words: AiWord[], o: { allowUnclear: boolean }) {
  const counts = { high: 0, medium: 0, low: 0, unclear: 0 }
  const out = words.map((w) => {
    if (w.edited || w.text === UNCLEAR) { counts.high++; return w }
    if (w.confidence >= TIER.high) { counts.high++; return w.flag === 'uncertain' && !w.alts?.length ? { ...w, flag: undefined } : w }
    if (w.confidence >= TIER.low) { counts.medium++; return w }
    if (o.allowUnclear && w.confidence < TIER.unclear && !w.verified && !w.backing) {
      counts.unclear++
      return { ...w, text: UNCLEAR, heard: w.text, flag: 'uncertain' as const }
    }
    counts.low++
    return { ...w, flag: w.flag === 'corrected' ? w.flag : ('uncertain' as const) }
  })
  return { words: out, counts }
}

// Stage 4/7: strictly chronological, non-overlapping word times. Words the recogniser stacked on one instant are spread
// across the time up to the next distinct word, instead of sharing a timestamp.
export function ensureChronological(words: AiWord[], durationSec: number): AiWord[] {
  const w = [...words].sort((a, b) => a.start - b.start).map((x) => ({ ...x }))
  for (let i = 0; i < w.length;) {
    let j = i + 1
    while (j < w.length && w[j].start - w[i].start < 0.02) j++
    if (j - i > 1) {
      const from = w[i].start
      const to = Math.max(from + 0.1 * (j - i), Math.min(j < w.length ? w[j].start : from + 0.3 * (j - i), from + 0.4 * (j - i)))
      const total = w.slice(i, j).reduce((s, x) => s + x.text.length + 1, 0)
      let t = from
      for (let k = i; k < j; k++) { const d = ((to - from) * (w[k].text.length + 1)) / total; w[k].start = t; w[k].end = Math.max(w[k].end, t + d * 0.9); t += d }
    }
    i = j
  }
  for (let i = 0; i < w.length; i++) {
    if (i > 0 && w[i].start < w[i - 1].start + 0.01) w[i].start = w[i - 1].start + 0.01
    if (i > 0 && w[i - 1].end > w[i].start) w[i - 1].end = w[i].start
    w[i].start = Math.min(w[i].start, Math.max(0, durationSec - 0.05))
    if (w[i].end < w[i].start + 0.03) w[i].end = w[i].start + 0.03
  }
  return w
}

// Stage 7: checks an LRC document is well-formed: valid [mm:ss.xx] stamps in chronological order.
export function validateLrc(lrc: string): string[] {
  const problems: string[] = []
  let last = -1
  lrc.split('\n').forEach((line, i) => {
    if (!line.trim() || /^\[[a-z]+:.*\]$/i.test(line)) return
    const m = line.match(/^\[(\d{2,}):([0-5]\d)\.(\d{2,3})\]/)
    if (!m) { problems.push(`Line ${i + 1} has no valid timestamp.`); return }
    const t = +m[1] * 60 + +m[2] + +m[3] / (m[3].length === 3 ? 1000 : 100)
    if (t < last) problems.push(`Line ${i + 1} (${lrcTime(t)}) is earlier than the line before it.`)
    last = t
  })
  return problems
}

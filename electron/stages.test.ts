import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits } from './refine'
import { applyConfidence, crossCheck, ensureChronological, uncoveredVocals, UNCLEAR, validateLrc, vocalRegions, markQuietBacking } from './stages'
import { AiLine, AiWord, alignToReference, harmonizeRepeats } from './timed'

// The user's real-world failure cases: [what was sung, what a context-driven system wrongly produced].
const CASES: [string, string][] = [
  ['ever married me', 'never married me'],
  ['He needed you', 'we needed you'],
  ["I'm not tryna see you didn't start this", "I'm not trying to see you getting started"],
  ["And she askin' if I ate", 'Is she asking if I hate'],
  ["pukin' out my guts", 'puking at my guts'],
  ['I command you', 'I could man you'],
  ["Don't invest in my life", "I'm in best in my life"],
  ['I just bring you doubt', 'I just bring you down'],
]

const words = (text: string, t0: number, conf: number): AiWord[] => text.split(' ').map((t, i) => ({ text: t, start: t0 + i * 0.4, end: t0 + i * 0.4 + 0.35, confidence: conf }))
const say = (ws: AiWord[]) => ws.map((w) => w.text).join(' ')
const line = (id: string, ws: AiWord[]): AiLine => ({ id, kind: 'vocal', start: ws[0].start, end: ws[ws.length - 1].end, words: ws })

for (const [sung, wrong] of CASES) {
  test(`regression "${sung}": no stage lets context override what was heard`, () => {
    const heard = words(sung, 10, 0.82)

    // Published lyrics (or any reference text) saying the wrong thing must not replace clearly heard words.
    const ref = alignToReference([...words('so here we go now', 6, 0.9), ...heard, ...words('and that is all', 16, 0.9)], `so here we go now\n${wrong}\nand that is all`)
    assert.ok(say(ref.words).includes(sung), `reference check rewrote it: ${say(ref.words)}`)

    // A context-based "certain" edit from the language model with no audio support only becomes a suggestion.
    const L = [line('L', heard)]
    const wrongWords = wrong.split(' ')
    const edits = heard.map((w, i) => ({ line_id: 'L', word_index: i, action: 'replace' as const, text: wrongWords[i] ?? '', certain: true, reason: 'context' }))
      .filter((e) => e.text && e.text !== heard[e.word_index].text)
    const alt = { span: 0, start: 9, end: 16, words: words(sung, 10, 0.8) } // the re-listening pass heard the same thing
    assert.equal(say(applyEdits(L, { edits, use_alternates: [] }, [alt]).lines[0].words), sung)

    // A second recognition pass that leans the wrong way, without clearly more confidence, can't win…
    const shaky = crossCheck(words(sung, 10, 0.62), words(wrong, 10, 0.6), { start: 9, end: 16 })
    assert.equal(say(shaky.words), sung)
    // …while one that clearly heard the right words fixes a first pass that misheard.
    const fixed = crossCheck(words(wrong, 10, 0.3), words(sung, 10, 0.86), { start: 9, end: 16 })
    assert.equal(say(fixed.words), sung)

    // A repeat of the line that was performed (or misheard) differently doesn't overwrite a clearly heard line.
    const h = harmonizeRepeats([line('a', words(sung, 10, 0.75)), line('b', words(wrong, 30, 0.9))])
    assert.equal(say(h.lines[0].words), sung)
  })
}

test('crossCheck: agreement raises confidence and verifies; disagreement flags and keeps the other reading', () => {
  const a = words('hold me close tonight', 10, 0.6)
  const b = words('hold me clothes tonight', 10, 0.65)
  const r = crossCheck(a, b, { start: 9, end: 13 })
  assert.equal(say(r.words), 'hold me close tonight')
  assert.equal(r.verified, 3)
  assert.ok(r.words[0].verified && Math.abs(r.words[0].confidence - 0.86) < 0.01)
  assert.equal(r.words[2].flag, 'uncertain')
  assert.deepEqual(r.words[2].alts, ['clothes'])
  const missed = crossCheck(words('hold close', 10, 0.6), [...words('hold', 10, 0.8), { text: 'me', start: 10.4, end: 10.6, confidence: 0.9 }, ...words('close', 10.8, 0.8)], { start: 9, end: 13 })
  assert.equal(say(missed.words), 'hold me close', 'a confidently heard word the first pass dropped is restored')
})

test('applyConfidence: tiers, [unclear] only for very low unverified lead words, guess kept for review', () => {
  const ws: AiWord[] = [
    { text: 'high', start: 0, end: 1, confidence: 0.9, flag: 'uncertain' },
    { text: 'medium', start: 1, end: 2, confidence: 0.65 },
    { text: 'low', start: 2, end: 3, confidence: 0.35 },
    { text: 'mumble', start: 3, end: 4, confidence: 0.1 },
    { text: 'echo', start: 4, end: 5, confidence: 0.1, backing: true },
    { text: 'agreed', start: 5, end: 6, confidence: 0.15, verified: true },
  ]
  const r = applyConfidence(ws, { allowUnclear: true })
  assert.deepEqual(r.counts, { high: 1, medium: 1, low: 3, unclear: 1 })
  assert.equal(r.words[0].flag, undefined)
  assert.equal(r.words[2].flag, 'uncertain')
  assert.equal(r.words[3].text, UNCLEAR)
  assert.equal(r.words[3].heard, 'mumble')
  assert.equal(r.words[4].text, 'echo')
  assert.equal(r.words[5].text, 'agreed')
  assert.equal(applyConfidence(ws, { allowUnclear: false }).counts.unclear, 0, "the user's own lyrics are never replaced")
})

test('ensureChronological spreads words stacked on one timestamp and keeps order strict', () => {
  const ws: AiWord[] = [
    { text: 'one', start: 5, end: 5.1, confidence: 1 }, { text: 'two', start: 5, end: 5.1, confidence: 1 }, { text: 'three', start: 5.005, end: 5.1, confidence: 1 },
    { text: 'four', start: 6, end: 6.3, confidence: 1 },
  ]
  const out = ensureChronological(ws, 60)
  const starts = out.map((w) => w.start)
  assert.equal(new Set(starts.map((s) => s.toFixed(2))).size, 4)
  for (let i = 1; i < out.length; i++) { assert.ok(out[i].start > out[i - 1].start); assert.ok(out[i - 1].end <= out[i].start + 1e-9) }
  assert.ok(out[2].start < 6)
})

test('vocal regions and uncovered vocals find ad-libs the transcript missed', () => {
  const env = new Float32Array(1000)
  for (let i = 100; i < 300; i++) env[i] = 0.5 // lead line 1–3 s
  for (let i = 320; i < 400; i++) env[i] = 0.3 // ad-lib 3.2–4 s, nothing transcribed
  const regions = vocalRegions(env, 0.01)
  assert.equal(regions.length, 1, 'a 0.2 s breath is bridged')
  const gaps = uncoveredVocals(regions, words('lead line words here', 1, 0.9))
  assert.equal(gaps.length, 1)
  assert.ok(gaps[0].start >= 2.6 && gaps[0].end <= 4.01, JSON.stringify(gaps))
})

test('validateLrc catches bad or out-of-order timestamps', () => {
  assert.deepEqual(validateLrc('[ti:x]\n[00:01.00]a\n[00:02.500]b'), [])
  assert.equal(validateLrc('[00:03.00]a\n[00:02.00]b').length, 1)
  assert.equal(validateLrc('[00:61.00]a').length, 1)
})

test('markQuietBacking: a phrase far below the surrounding lead is marked backing, the lead is not', () => {
  const env = new Float32Array(1000)
  const lead = [[0.5, 1.5], [3, 4], [5.5, 6.5], [9, 10]]
  for (const [a, b] of lead) for (let i = a * 100; i < b * 100; i++) env[i] = 0.4
  for (let i = 700; i < 800; i++) env[i] = 0.1 // ad-lib at 7-8 s, about -12 dB
  const ws = [...lead.map(([a, b]) => ({ text: 'lead', start: a, end: b, confidence: 0.9 })), { text: 'yeah', start: 7, end: 8, confidence: 0.9 }].map((w): AiWord => w).sort((a, b) => a.start - b.start)
  const regions = vocalRegions(env, 0.01)
  // the lead's last word runs on over the silence up to the ad-lib, as raw Whisper timings do
  ws[2].end = 6.99
  assert.equal(markQuietBacking(ws, env, 0.01, regions), 1)
  assert.deepEqual(ws.filter((w) => w.backing).map((w) => w.text), ['yeah'])
  const flat = ws.map((w) => ({ ...w, backing: undefined }))
  for (let i = 700; i < 800; i++) env[i] = 0.35
  assert.equal(markQuietBacking(flat, env, 0.01, vocalRegions(env, 0.01)), 0, 'similar loudness is lead')
})

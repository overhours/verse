import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choices, logProgress, parseOpenAI, parseWhisperX } from './providers'
import { applyEdits, voteAlternates } from './refine'
import { parseWhisperCpp } from './local'
import {
  AiLine, AiLyrics, AiWord, accuracyScore, newId, alignToReference, alignWords, buildLines, cleanWords, dropSilent, syncLyricsToAudio, fromLyrics, harmonizeRepeats, tapLine, labelSections, lrcTime, planChunks, repeatGroups, snapToEnergy, srtTime,
  toEnhancedLrc, toJson, toLrc, toSrt, toTxt, unclearSpans,
} from './timed'

const w = (text: string, start: number, end: number, confidence = 0.9, extra: Partial<AiWord> = {}): AiWord => ({ text, start, end, confidence, ...extra })

test('timestamp formats round and carry correctly', () => {
  assert.equal(lrcTime(59.999), '01:00.00')
  assert.equal(lrcTime(83.456), '01:23.46')
  assert.equal(srtTime(3723.0456), '01:02:03,046')
  assert.equal(srtTime(-1), '00:00:00,000')
})

test('cleanWords drops hallucinations and fills untimed words from neighbours', () => {
  const out = cleanWords([
    w('hello', 1, 1.4, 0.9, { seg: 0 }), w('there', NaN, NaN, 0.8, { seg: 0 }), w('friend', 2, 2.5, 0.9, { seg: 0 }),
    w('Thanks', 9, 9.3, 0.9, { seg: 1 }), w('for', 9.3, 9.5, 0.9, { seg: 1 }), w('watching', 9.5, 10, 0.9, { seg: 1 }),
    w('...', 11, 11.2), w('(ooh)', 12, 12.5, 0.3),
  ], 20)
  assert.deepEqual(out.map((x) => x.text), ['hello', 'there', 'friend', '(ooh)'])
  assert.ok(out[1].start >= 1.4 && out[1].end <= 2, 'filled inside the gap, not spread across the song')
  assert.ok(out[1].confidence <= 0.3)
  assert.equal(out[3].backing, true)
  assert.equal(out[3].flag, 'uncertain')
})

test('cleanWords removes overlaps and keeps order', () => {
  const out = cleanWords([w('b', 2, 3), w('a', 1, 2.5)], 10)
  assert.deepEqual(out.map((x) => [x.text, x.start, x.end]), [['a', 1, 2], ['b', 2, 3]])
})

test('snapToEnergy trims silent tails and leads but never inverts words', () => {
  const hop = 0.01
  const env = new Float32Array(500) // 5 s
  for (let i = 100; i < 150; i++) env[i] = 0.5 // voice 1.0–1.5 s
  for (let i = 300; i < 340; i++) env[i] = 0.5 // voice 3.0–3.4 s
  const [a, b] = snapToEnergy([w('one', 0.8, 2.5), w('two', 3, 3.4)], env, hop)
  assert.ok(a.start >= 0.95 && a.start <= 1.0, `start ${a.start}`)
  assert.ok(a.end >= 1.45 && a.end <= 1.6, `end ${a.end}`)
  assert.ok(b.start >= 2.9 && b.end <= 3.45 && b.end > b.start)
})

test('buildLines breaks on gaps, punctuation and speakers, and inserts instrumental breaks', () => {
  const words = [
    w('I', 10, 10.2), w('walk', 10.2, 10.6), w('alone.', 10.6, 11),
    w('Every', 11.1, 11.4), w('night', 11.4, 11.8),
    w('Hey', 30, 30.3, 0.9, { speaker: 'SPEAKER_01' }), w('you', 30.3, 30.6, 0.9, { speaker: 'SPEAKER_01' }),
  ]
  const lines = buildLines(words, { durationSec: 60 })
  assert.deepEqual(lines.map((l) => l.kind === 'vocal' ? l.words.map((x) => x.text).join(' ') : 'INSTR'),
    ['INSTR', 'I walk alone.', 'Every night', 'INSTR', 'Hey you', 'INSTR'])
  assert.equal(lines[4].speaker, 'SPEAKER_01')
})

test('labelSections marks repeated runs as chorus; repeatGroups finds near-duplicates', () => {
  const L = (text: string, t: number, conf = 0.9): AiLine => ({ id: `id${t}`, kind: 'vocal', start: t, end: t + 1, words: text.split(' ').map((x, i) => w(x, t + i * 0.1, t + i * 0.1 + 0.1, conf)) })
  const lines = [L('verse line one', 0), L('we will rise again', 2), L('into the light', 4), L('other verse', 6), L('we will rise again', 8), L('into the light', 10), L('we will rice again', 12)]
  assert.deepEqual(labelSections(lines).map((l) => l.section ?? ''), ['', 'Chorus', '', '', 'Chorus', '', ''])
  assert.deepEqual(repeatGroups(lines), [['id2', 'id8', 'id12'], ['id4', 'id10']])
})

test('planChunks cuts at silences, or overlaps hard cuts without losing coverage', () => {
  assert.deepEqual(planChunks([], 300, 600), [{ start: 0, end: 300, keepFrom: 0, keepTo: 300 }])
  const soft = planChunks([{ start: 500, end: 502 }, { start: 1000, end: 1001 }], 1300, 600)
  assert.deepEqual(soft.map((c) => [c.start, c.end]), [[0, 501], [501, 1000.5], [1000.5, 1300]])
  const hard = planChunks([], 1300, 600, 2)
  assert.deepEqual(hard, [
    { start: 0, end: 602, keepFrom: 0, keepTo: 600 }, { start: 598, end: 1202, keepFrom: 600, keepTo: 1200 }, { start: 1198, end: 1300, keepFrom: 1200, keepTo: 1300 },
  ])
})

test('unclearSpans merges nearby low-confidence words and caps the count', () => {
  const words = [w('a', 5, 5.2, 0.2), w('b', 5.5, 5.8, 0.3), w('c', 20, 20.3, 0.95), w('d', 40, 40.2, 0.1)]
  assert.deepEqual(unclearSpans(words, { durationSec: 60 }).map((s) => [s.start, s.end, s.n]), [[4, 6.8, 2], [39, 41.2, 1]])
  assert.equal(unclearSpans(words, { durationSec: 60, max: 1 }).length, 1)
})

test('exports produce valid LRC, enhanced LRC, SRT, TXT and JSON', () => {
  const ai: AiLyrics = {
    version: 1, hash: 'h', durationSec: 75, createdAt: 0, notes: [], providers: { transcription: 't' },
    lines: [
      { id: 'i0', kind: 'instrumental', start: 0, end: 10, words: [] },
      { id: 'a', kind: 'vocal', start: 10.5, end: 12, section: 'Chorus', words: [w('Hold', 10.5, 11), w('on', 11.2, 12, 0.3, { flag: 'uncertain' })] },
    ],
  }
  const meta = { title: 'Song', artist: 'Band' }
  assert.match(toLrc(ai, meta), /\[ti:Song\]\n\[ar:Band\]\n\[length:01:15\][\s\S]*\[00:00.00\]\n\[00:10.50\]Hold on\n$/)
  assert.match(toEnhancedLrc(ai, meta), /\[00:10.50\] <00:10.50> Hold <00:11.20> on <00:12.00>\n$/)
  assert.equal(toSrt(ai), '1\n00:00:10,500 --> 00:00:12,000\nHold on\n')
  assert.equal(toTxt(ai), '[Instrumental]\n\nHold on\n')
  const j = JSON.parse(toJson(ai, meta))
  assert.equal(j.lines[1].words[1].uncertain, true)
  assert.equal(j.lines[1].words[0].confidence, 0.9)
})

test('parses WhisperX output including unaligned segments and speakers', () => {
  const r = parseWhisperX({
    detected_language: 'en',
    segments: [
      { start: 1, end: 2, text: ' Hi there', speaker: 'SPEAKER_00', words: [{ word: 'Hi', start: 1, end: 1.3, score: 0.91 }, { word: 'there', score: 0.5 }] },
      { start: 3, end: 5, text: ' two words' },
    ],
  })
  assert.equal(r.language, 'en')
  assert.deepEqual(r.words.map((x) => [x.text, x.start, x.speaker, x.seg]), [['Hi', 1, 'SPEAKER_00', 0], ['there', NaN, 'SPEAKER_00', 0], ['two', 3, undefined, 1], ['words', 4, undefined, 1]])
  assert.equal(r.words[2].confidence, 0.3)
})

test('parses OpenAI verbose_json and drops non-speech segments', () => {
  const r = parseOpenAI({
    language: 'english',
    segments: [{ start: 0, end: 2, avg_logprob: -0.1, no_speech_prob: 0.05 }, { start: 5, end: 7, avg_logprob: -1.5, no_speech_prob: 0.9 }],
    words: [{ word: 'Hello', start: 0.2, end: 0.6 }, { word: 'noise', start: 5.5, end: 6 }],
  })
  assert.deepEqual(r.words.map((x) => x.text), ['Hello'])
  assert.ok(r.words[0].confidence > 0.8 && r.words[0].confidence < 0.9)
})

test('reads enum choices from inline and $ref schema properties; parses tqdm progress', () => {
  const s = { properties: { stem: { allOf: [{ $ref: '#/components/schemas/stem' }] }, fmt: { enum: ['mp3', 'wav'] } }, defs: { stem: { enum: ['none', 'vocals'] } } }
  assert.deepEqual(choices(s, 'stem'), ['none', 'vocals'])
  assert.deepEqual(choices(s, 'fmt'), ['mp3', 'wav'])
  assert.deepEqual(logProgress('loading\n 12%|█ | 3/25\r 48%|████ | 12/25\n'), { fraction: 0.48, line: '48%|████ | 12/25' })
  assert.deepEqual(logProgress(''), { fraction: undefined, line: undefined })
})

test('applyEdits: only audio-supported edits change words; the rest become suggestions; alternates replace the window', () => {
  const lines: AiLine[] = [{ id: 'L', kind: 'vocal', start: 1, end: 4, words: [w('I', 1, 1.2), w('scream', 1.3, 2, 0.3), w('four', 2.1, 2.6, 0.3), w('ice', 2.7, 3, 0.4), w('cream', 3.1, 4)] }]
  const { lines: out, changed } = applyEdits(lines, {
    edits: [
      { line_id: 'L', word_index: 1, action: 'replace', text: 'scream', certain: true, reason: 'same' },
      { line_id: 'L', word_index: 2, action: 'replace', text: 'for the', certain: false, reason: 'context' },
      { line_id: 'L', word_index: 3, action: 'flag', text: '', certain: false, reason: '?' },
      { line_id: 'L', word_index: 0, action: 'delete', text: '', certain: true, reason: 'x' },
    ],
    use_alternates: [],
  }, [{ span: 9, start: 0, end: 5, words: [w('I', 1, 1.2), w('scream', 1.3, 2), w('for the', 2.1, 2.6), w('ice', 2.7, 3), w('cream', 3.1, 4)] }])
  // 'for the' was heard by the second pass but the edit wasn't certain -> suggestion only; 'I' was heard -> not deleted.
  assert.equal(changed, 0)
  const ws = out[0].words
  assert.deepEqual(ws.map((x) => x.text), ['I', 'scream', 'four', 'ice', 'cream'])
  assert.deepEqual(ws[2].alts, ['for the'])
  assert.equal(ws[2].flag, 'uncertain')
  assert.equal(ws[3].flag, 'uncertain')
  // A certain edit the second pass heard at that moment is applied, splitting inside the original word's time.
  const heardIt = applyEdits(lines, { edits: [{ line_id: 'L', word_index: 2, action: 'replace', text: 'for the', certain: true, reason: '' }], use_alternates: [] },
    [{ span: 9, start: 0, end: 5, words: [w('for', 2.1, 2.35), w('the', 2.35, 2.6)] }])
  const hw = heardIt.lines[0].words
  assert.deepEqual(hw.map((x) => x.text), ['I', 'scream', 'for', 'the', 'ice', 'cream'])
  assert.equal(hw[2].start, 2.1)
  assert.ok(Math.abs(hw[3].end - 2.6) < 1e-9)
  assert.equal(hw[2].flag, 'corrected')

  const alt = { span: 0, start: 0.5, end: 4.5, words: [w('Ice', 1.4, 1.8), w('scream', 1.9, 2.4)] }
  const r2 = applyEdits(lines, { edits: [{ line_id: 'L', word_index: 1, action: 'delete', text: '', certain: true, reason: '' }], use_alternates: [{ span: 0, reason: 'better' }] }, [alt])
  const texts = r2.lines.flatMap((l) => l.words.map((x) => x.text))
  assert.deepEqual(texts, ['Ice', 'scream'])
  assert.ok(r2.lines.flatMap((l) => l.words).every((x) => x.flag === 'corrected'))
})

test('parses whisper.cpp full JSON into words, joining sub-word tokens and skipping specials', () => {
  const r = parseWhisperCpp({
    result: { language: 'en' },
    transcription: [{
      offsets: { from: 1000, to: 3000 }, text: ' Never gonna',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 1000, to: 1000 }, p: 0.9, t_dtw: -1 },
        { text: ' Ne', offsets: { from: 1000, to: 1200 }, p: 0.9, t_dtw: 105 },
        { text: 'ver', offsets: { from: 1200, to: 1500 }, p: 0.7, t_dtw: 120 },
        { text: ' gonna', offsets: { from: 1600, to: 2100 }, p: 0.4, t_dtw: -1 },
        { text: ',', offsets: { from: 2100, to: 2200 }, p: 0.8 },
        { text: '[_TT_150]', offsets: { from: 3000, to: 3000 }, p: 0.5 },
      ],
    }],
  })
  assert.equal(r.language, 'en')
  assert.deepEqual(r.words.map((w) => [w.text, w.start, +w.end.toFixed(2), +w.confidence.toFixed(2)]), [['Never', 1.05, 1.58, 0.8], ['gonna,', 1.6, 2.2, 0.6]])
  const d = parseWhisperCpp({ transcription: [{ offsets: { from: 0, to: 9000 }, text: '', tokens: [
    { text: ' a', offsets: { from: 0, to: 800 }, p: 1, t_dtw: 600 }, { text: ' b', offsets: { from: 800, to: 9000 }, p: 1, t_dtw: 650 }] }] })
  assert.deepEqual(d.words.map((w) => [w.start, +w.end.toFixed(2)]), [[6, 6.48], [6.5, 7.3]], 'DTW onsets win; ends come from the next onset')
})

test('voteAlternates keeps a second pass only when it is clearly more confident', () => {
  const L: AiLine[] = [{ id: 'a', kind: 'vocal', start: 0, end: 10, words: [w('blur', 2, 2.5, 0.3), w('red', 2.6, 3, 0.35)] }]
  const better = { span: 0, start: 1, end: 4, words: [w('blue', 2, 2.5, 0.8), w('bird', 2.6, 3, 0.75)] }
  const same = { span: 1, start: 1, end: 4, words: [w('blew', 2, 2.5, 0.36), w('red', 2.6, 3, 0.35)] }
  assert.deepEqual(voteAlternates(L, [better, same]).use_alternates.map((u) => u.span), [0])
})

test('removes Whisper repetition loops but keeps genuinely repeated lines', () => {
  const line = 'Can you sniff it baby, know that you were major?'.split(' ')
  const seg = (s: number, start: number, per: number) => line.map((t, i) => w(t, start + i * per, start + (i + 1) * per, 0.9, { seg: s }))
  const words = [
    ...seg(0, 70.0, 0.25), // real chorus line
    ...seg(1, 80.0, 0.25), // the same line sung again later: legitimate
    ...seg(2, 90.34, 0.23), // last real line before the outro
    ...seg(3, 92.64, 0.002), ...seg(4, 92.66, 0.002), ...seg(5, 92.8, 0.001), ...seg(6, 92.98, 0), // loop squeezed into ~0.3 s
  ]
  const out = cleanWords(words, 112)
  assert.deepEqual([...new Set(out.map((x) => x.seg))], [0, 1, 2])
  assert.equal(out.length, line.length * 3)
})

const heard = (s: string, t0: number, conf = 0.8) => s.split(' ').map((t, i) => w(t, t0 + i * 0.5, t0 + i * 0.5 + 0.4, conf))

test('alignWords pairs similar spellings and marks gaps', () => {
  assert.deepEqual(alignWords(['i', 'scream', 'cream'], ['ice', 'cream']), [{ a: 0, b: 0 }, { a: 1, b: -1 }, { a: 2, b: 1 }])
  assert.deepEqual(alignWords(['thinkin'], ['thinking']), [{ a: 0, b: 0 }])
})

test('alignToReference fixes mishearings, restores short missed words, keeps timing, flags ad-libs', () => {
  const words = heard('we are no strangers to glove you know the rules yeah and so do I', 10)
  words[5].confidence = 0.4 // the recogniser was unsure of 'glove'
  const ref = "[Verse 1]\nWe're no strangers to love\nYou know the rules and so do I"
  const r = alignToReference(words, ref)
  assert.equal(r.used, true)
  const out = r.words
  assert.equal(out.map((x) => x.text + (x.flag ? '(' + x.flag[0] + ')' : '')).join(' '), 'we are(u) no strangers to love(c) You know the rules yeah(u) and so do I')
  const love = out.find((x) => x.text === 'love')!
  assert.equal(love.flag, 'corrected')
  assert.equal(love.start, words[5].start, 'corrected word keeps its own timing')
  assert.equal(out.find((x) => x.text === 'yeah')!.flag, 'uncertain')
  assert.equal(out.find((x) => x.text === 'rules')!.line, 2)
  assert.equal(out.find((x) => x.text === 'You')!.line, 2)
  assert.ok(r.corrected >= 1)
  // A clearly heard word that differs from the published lyrics is kept, with their reading as a suggestion.
  const sure = alignToReference(heard('we are no strangers to glove you know the rules yeah and so do I', 10, 0.9), ref).words.find((x) => x.text === 'glove')!
  assert.deepEqual(sure.alts, ['love'])
})

test('alignToReference rejects lyrics from a different song', () => {
  const r = alignToReference(heard('the city lights are burning bright tonight', 0), 'Never gonna give you up\nNever gonna let you down')
  assert.equal(r.used, false)
})

test('alignToReference inserts a word Whisper skipped, between its neighbours', () => {
  const words = [w('hold', 1, 1.3), w('to', 1.8, 2.0), w('me', 2.1, 2.4)]
  const r = alignToReference(words, 'Hold on to me')
  const on = r.words.find((x) => x.text === 'on')!
  assert.equal(r.inserted, 1)
  assert.ok(on.start >= 1.3 && on.end <= 1.8 + 1e-9, `${on.start}-${on.end}`)
  assert.deepEqual(r.words.map((x) => x.text), ['Hold', 'on', 'to', 'me'])
})

test('harmonizeRepeats copies the confident chorus reading onto a shaky repeat', () => {
  const L = (id: string, text: string, confs: number[], t: number): AiLine => ({ id, kind: 'vocal', start: t, end: t + 3,
    words: text.split(' ').map((x, i) => w(x, t + i * 0.5, t + i * 0.5 + 0.4, confs[i])) })
  const lines = [L('a', 'hold me close tonight', [0.9, 0.9, 0.95, 0.9], 0), L('b', 'hold me clothes tonight', [0.9, 0.9, 0.4, 0.9], 10)]
  const r = harmonizeRepeats(lines)
  assert.equal(r.changed, 1)
  assert.deepEqual(r.lines[1].words.map((x) => x.text), ['hold', 'me', 'close', 'tonight'])
  assert.equal(r.lines[1].words[2].start, 11, 'timing untouched')
})

test('snapToEnergy pulls a late word start back to the vocal onset, only on an isolated vocal track', () => {
  const env = new Float32Array(300) // 3 s
  for (let i = 100; i < 200; i++) env[i] = 0.5 // voice 1.0–2.0 s
  const words = [w('before', 0.2, 0.5), w('late', 1.35, 1.9)]
  assert.ok(Math.abs(snapToEnergy(words, env, 0.01, true)[1].start - 1.0) < 0.02)
  assert.equal(snapToEnergy(words, env, 0.01, false)[1].start, 1.35, 'unchanged on a full mix')
  const legato = [w('held', 0.9, 1.2), w('next', 1.3, 1.9)] // voice continues from the previous word: no onset to find
  assert.equal(snapToEnergy(legato, env, 0.01, true)[1].start, 1.3)
})

test('fromLyrics keeps synced times and flags plain lyrics as untimed', () => {
  const synced = fromLyrics([{ time: 5, text: 'Hello there' }, { time: 9, text: 'General Kenobi' }], 30, 'h')
  assert.deepEqual(synced.lines.map((l) => [l.start, l.words.map((x) => x.text).join(' ')]), [[5, 'Hello there'], [9, 'General Kenobi']])
  assert.ok(synced.lines[0].words[1].start > 5 && synced.lines[0].end <= 9)
  const plain = fromLyrics([{ text: '[Chorus]' }, { text: 'one two' }, { text: '' }, { text: 'three' }], 30, 'h')
  assert.equal(plain.lines.length, 2)
  assert.ok(plain.lines.flatMap((l) => l.words).every((x) => x.flag === 'uncertain'))
})

test('tapLine sets a line start, closes the previous line, and keeps later lines in order', () => {
  let lines = fromLyrics([{ text: 'first line here' }, { text: 'second' }, { text: 'third one' }], 30, 'h').lines
  lines = tapLine(lines, 0, 2)
  lines = tapLine(lines, 1, 6)
  assert.equal(lines[0].start, 2)
  assert.ok(Math.abs(lines[0].end - 5.95) < 0.1, `prev line ends before the tap: ${lines[0].end}`)
  assert.equal(lines[1].start, 6)
  assert.ok(lines[2].start > lines[1].end, 'third stays after second')
  assert.ok(lines[1].words.every((x) => x.flag === undefined))
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].start >= lines[i - 1].start)
})

test('drops Whisper silence hallucinations: known phrases, and words over a silent vocal track', () => {
  const out = cleanWords([w('Thank', 0.3, 0.5, 0.5, { seg: 0 }), w('you.', 0.6, 0.9, 0.99, { seg: 0 }), w('Thank', 5, 5.3, 0.9, { seg: 1 }), w('you', 5.3, 5.6, 0.9, { seg: 1 }), w('so', 5.6, 5.8, 0.9, { seg: 1 })], 30)
  assert.deepEqual(out.map((x) => x.text), ['Thank', 'you', 'so'], 'a real line that merely starts with "thank you" is kept')
  const env = new Float32Array(300)
  for (let i = 100; i < 150; i++) env[i] = 0.4
  assert.deepEqual(dropSilent([w('ghost', 0.2, 0.5), w('real', 1.1, 1.4)], env, 0.01).map((x) => x.text), ['real'])
  assert.equal(dropSilent([w('ghost', 0.2, 0.5)], new Float32Array(300), 0.01).length, 0, 'an all-silent stem keeps nothing')
  // voice 1.0-1.5 s; the phrase's last word is stamped at 1.6-2.4 s, just after the voice stops
  const late = dropSilent([w('start', 1.1, 1.45), w('this.', 1.6, 2.4)], env, 0.01)
  assert.deepEqual(late.map((x) => x.text), ['start', 'this.'], 'a late-stamped final word is kept')
  assert.ok(late[1].start < 1.5 && late[1].end <= 1.6 && late[0].end <= late[1].start, 'and moved back onto the voice')
})

test('syncLyricsToAudio keeps the user text and order, times it from the heard words, handles repeats and gaps', () => {
  const heard = [
    ['hold', 10.0], ['me', 10.4], ['close', 10.8], ['tonight', 11.3], // verse line 1
    ['we', 12.5], ['run', 12.9], ['the', 13.2], ['streets', 13.5],     // verse line 2 ("light" missing below)
    ['oh', 30.0], ['never', 30.4], ['let', 30.9], ['go', 31.2],        // chorus 1 (after a 15 s instrumental)
    ['oh', 40.0], ['never', 40.4], ['let', 40.9], ['go', 41.2],        // chorus 2
    ['clothes', 50.8],                                                 // misheard "close"
  ].map(([t, s]) => w(t as string, s as number, (s as number) + 0.3, 0.9))
  const text = '[Verse]\nHold me close tonight\nWe run the streets\nOn neon light\n\n[Chorus]\nOh, never let go\n[Chorus]\nOh, never let go\nClose'
  const r = syncLyricsToAudio(text, heard, 60)
  const vocal = r.lines.filter((l) => l.kind === 'vocal')
  assert.deepEqual(vocal.map((l) => l.words.map((x) => x.text).join(' ')), ['Hold me close tonight', 'We run the streets', 'On neon light', 'Oh, never let go', 'Oh, never let go', 'Close'])
  assert.deepEqual(vocal.map((l) => +l.start.toFixed(2)), [10, 12.5, 13.8, 30, 40, 50.8])
  assert.equal(vocal[0].section, 'Verse')
  assert.equal(vocal[3].section, 'Chorus')
  assert.equal(vocal[4].section, 'Chorus')
  assert.ok(vocal[2].words.every((x) => x.flag === 'uncertain'), 'unheard line is flagged')
  assert.ok(vocal[2].end < 30, 'unheard line stays before the chorus')
  assert.equal(vocal[5].words[0].flag, 'uncertain', 'misheard word keeps its timing but is flagged')
  assert.ok(r.lines.some((l) => l.kind === 'instrumental' && l.start < 30 && l.end === 30))
  for (let i = 1; i < vocal.length; i++) assert.ok(vocal[i].start > vocal[i - 1].start)
  assert.equal(r.matched, 16)
})

test('snapToEnergy: quiet backing words are not trimmed; a late onset on isolated vocals is found up to 1 s on', () => {
  const env = new Float32Array(500)
  for (let i = 100; i < 200; i++) env[i] = 0.4 // lead 1-2 s
  for (let i = 300; i < 380; i++) env[i] = 0.03 // quiet ad-lib 3-3.8 s, below the lead threshold
  const [lead, back] = snapToEnergy([w('Dont', 0.1, 1.9), { ...w('yeah', 3.0, 3.8), backing: true }], env, 0.01, true)
  assert.ok(Math.abs(lead.start - 1) < 0.05, `lead onset found (${lead.start})`)
  assert.deepEqual([back.start, back.end], [3.0, 3.8])
})

test('buildLines follows phrases: no breaks mid-sentence on segment edges, breaths or word caps', () => {
  const say = (text: string, t0: number, step = 0.3, extra: Partial<AiWord> = {}) => text.split(' ').map((x, i) => w(x, t0 + i * step, t0 + i * step + step * 0.9, 0.9, extra))
  const text = (ls: AiLine[]) => ls.filter((l) => l.kind === 'vocal').map((l) => l.words.map((x) => x.text).join(' '))
  // Whisper's segment boundary falls after "the"; the real phrase break is the pause after "night".
  const a = [...say("I've been running through the", 0, 0.3, { seg: 0 }), ...say('night', 1.5, 0.3, { seg: 1 }), ...say("and I can't find my way back home", 2.4, 0.3, { seg: 1 })]
  assert.deepEqual(text(buildLines(a, { durationSec: 10 })), ["I've been running through the night", "and I can't find my way back home"])
  // A breath after "my" is not a line break.
  const b = [...say('I gave you all my', 0), ...say('heart and soul tonight', 2.5)]
  assert.deepEqual(text(buildLines(b, { durationSec: 10 })), ['I gave you all my heart and soul tonight'])
  // 16 words with no punctuation: split at the pause, not at a fixed word count.
  const c = [...say('we were dancing in the kitchen with the radio on', 0), ...say('and nobody else was there', 3.6)]
  assert.deepEqual(text(buildLines(c, { durationSec: 10 })), ['we were dancing in the kitchen with the radio on', 'and nobody else was there'])
  // A long run with no cues still never ends a line on "the".
  const d = say('so we keep on going down the road we know and the road we never knew before tonight', 0, 0.25)
  for (const l of text(buildLines(d, { durationSec: 10 }))) assert.ok(!/ (the|and|we)$/.test(l), l)
})

test('accuracyScore: confidence-weighted, checked words count as right, [unclear] as wrong, plus agreement with published lyrics', () => {
  const L = (ws: AiWord[], backing?: boolean): AiLine => ({ id: newId(), kind: 'vocal', start: ws[0].start, end: ws[ws.length - 1].end, words: ws, backing })
  const lines = [
    L([w('ever', 0, 0.3, 0.9, { verified: true }), w('married', 0.3, 0.6, 0.5, { flag: 'uncertain' }), w('me', 0.6, 0.9, 0.2, { edited: true }), w('[unclear]', 0.9, 1.2, 0.1, { flag: 'uncertain' })]),
    L([w('yeah', 2, 2.3, 0.9, { backing: true })], true),
  ]
  const s = accuracyScore(lines)
  assert.equal(s.score, Math.round(((0.9 + 0.5 + 1 + 0 + 0.9) / 5) * 100))
  assert.deepEqual([s.words, s.checked, s.heardTwice, s.toReview, s.unclear, s.reference], [5, 1, 1, 2, 1, undefined])
  const sung = 'I just bring you doubt and nobody ever married me at all'
  const t = sung.split(' ').map((x, i) => w(x, i, i + 0.5, 0.9))
  assert.equal(accuracyScore([L(t)], '[Verse]\n' + sung).reference, 100, 'section headers are ignored')
  assert.ok(accuracyScore([L(t)], sung.replace('doubt', 'down')).reference! < 100)
  assert.equal(accuracyScore([L(t)], 'too short').reference, undefined)
})

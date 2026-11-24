import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { Cancelled } from './audio'
import { AiLine, AiWord, newId, tok, withAlt } from './timed'

export interface Alternate { span: number; start: number; end: number; words: AiWord[] }

const Edits = z.object({
  edits: z.array(z.object({
    line_id: z.string(),
    word_index: z.number().int(),
    action: z.enum(['replace', 'delete', 'flag']),
    text: z.string(),
    certain: z.boolean(),
    reason: z.string(),
  })),
  use_alternates: z.array(z.object({ span: z.number().int(), reason: z.string() })),
})
export type EditPlan = z.infer<typeof Edits>

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['edits', 'use_alternates'],
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['line_id', 'word_index', 'action', 'text', 'certain', 'reason'],
        properties: {
          line_id: { type: 'string' },
          word_index: { type: 'integer' },
          action: { type: 'string', enum: ['replace', 'delete', 'flag'] },
          text: { type: 'string', description: 'Replacement text for "replace"; empty for "delete" and "flag".' },
          certain: { type: 'boolean', description: 'True only when the audio evidence (alternate pass or a clearer chorus repeat) supports the change.' },
          reason: { type: 'string' },
        },
      },
    },
    use_alternates: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['span', 'reason'], properties: { span: { type: 'integer' }, reason: { type: 'string' } } },
    },
  },
}

const SYSTEM = `You review an automatic speech-recognition transcript of the sung vocals in a song and propose minimal corrections.

Input: "lines" (each word has its index "i", text "t" and recognizer confidence "c" from 0 to 1), "alternates" (a second, independent recognition pass over spans where confidence was low, with their own word timings) and "repeats" (groups of line ids that are repetitions of the same lyric, such as a chorus).

Rules:
- You cannot hear the audio. The goal is what is actually sung, not what would make the most sense. Lyrics are often ungrammatical, slangy or surprising, and that is correct.
- Keep the singer's wording exactly: contractions and dropped letters (tryna, askin', ain't, gonna, 'cause), dialect, profanity and vocalisations (oh, yeah, la). Never expand, standardise or "improve" them.
- Be especially wary of similar-sounding alternatives (ate/hate, ever/never, he/we, doubt/down, command/could man). Context alone is not a reason to switch between them.
- Only propose a change when the input supports it: the alternate pass heard that word at that moment, or a clearer instance of the same repeated line. Set "certain" to true only for those. Anything else must have "certain": false.
- The app only applies a change when the alternate pass actually heard the new word in the same place; everything else is shown to the user as a suggestion. So a context-only idea is only useful as a suggestion with "certain": false.
- Never invent lines or add lyrics that appear in no hypothesis. Prefer "flag" over "replace" when unsure.
- Use "use_alternates" when the alternate pass for a span reads as clearly better lyrics than the original words in that time range; it replaces those words with the alternate words and timings.
- Make repeated lines consistent only where the differing words in one instance have lower confidence than in another.
- Return empty arrays when nothing should change.`

export async function reviewWithClaude(apiKey: string, lines: AiLine[], alternates: Alternate[], repeats: string[][], signal: AbortSignal): Promise<EditPlan> {
  const client = new Anthropic({ apiKey, maxRetries: 4 })
  const payload = {
    lines: lines.filter((l) => l.kind === 'vocal').map((l) => ({
      id: l.id, start: +l.start.toFixed(2), speaker: l.speaker, words: l.words.map((w, i) => ({ i, t: w.text, c: +w.confidence.toFixed(2) })),
    })),
    alternates: alternates.map((a) => ({ span: a.span, start: +a.start.toFixed(2), end: +a.end.toFixed(2), text: a.words.map((w) => w.text).join(' ') })),
    repeats,
  }
  let res
  try {
    res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }, { signal })
  } catch (e) {
    if (signal.aborted) throw new Cancelled()
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Check it in AI settings.')
    if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic is rate-limiting requests. Wait a minute and retry.')
    if (e instanceof Anthropic.APIError) throw new Error(`Claude returned an error (${e.status ?? 'network'}): ${e.message}`)
    throw e
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to review this transcript.')
  if (res.stop_reason === 'max_tokens') throw new Error('Claude’s review was cut short; the transcript was kept as transcribed.')
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return Edits.parse(JSON.parse(text))
}

// Free refinement: keep the second pass for a span only when the recogniser was clearly more confident in it.
export function voteAlternates(lines: AiLine[], alternates: Alternate[], margin = 0.08): EditPlan {
  const mean = (ws: AiWord[]) => ws.reduce((s, w) => s + w.confidence, 0) / (ws.length || 1)
  const words = lines.flatMap((l) => l.words)
  const use = alternates.filter((a) => {
    const inner = (w: AiWord) => { const m = (w.start + w.end) / 2; return m >= a.start + 0.3 && m <= a.end - 0.3 }
    const alt = a.words.filter(inner), orig = words.filter(inner)
    return alt.length > 0 && mean(alt) > mean(orig) + margin
  })
  return { edits: [], use_alternates: use.map((a) => ({ span: a.span, reason: 'higher recogniser confidence' })) }
}

// Applies a plan. Word edits address the lines as sent; alternates replace words inside their time window.
export function applyEdits(lines: AiLine[], plan: EditPlan, alternates: Alternate[]): { lines: AiLine[]; changed: number } {
  let changed = 0
  const chosen = plan.use_alternates.map((u) => alternates.find((a) => a.span === u.span)).filter((a): a is Alternate => !!a)
  // Edge words of a clip are often cut off, so only the interior of each window is replaced.
  const inside = (w: AiWord, a: Alternate) => { const m = (w.start + w.end) / 2; return m >= a.start + 0.3 && m <= a.end - 0.3 }
  const mid = (w: AiWord) => (w.start + w.end) / 2
  // Context may suggest, but only audio may change a word: the re-listening pass must have heard the new word here,
  // or (for a deletion) heard nothing here at all.
  const overlaps = (x: AiWord, w: AiWord) => Math.min(x.end, w.end) - Math.max(x.start, w.start) > 0.5 * Math.min(x.end - x.start, w.end - w.start)
  const heardHere = (w: AiWord, text: string) => alternates.some((a) => inside(w, a) && a.words.some((x) => tok(x.text) === tok(text.trim().split(' ')[0]) && overlaps(x, w)))
  const silentHere = (w: AiWord) => alternates.some((a) => inside(w, a) && !a.words.some((x) => Math.abs(mid(x) - mid(w)) < 0.4))
  const suggest = (w: AiWord, text: string): AiWord => ({ ...w, flag: w.confidence >= 0.8 ? w.flag : 'uncertain', alts: text.trim() ? withAlt(w.alts, text.trim()) : w.alts })

  let out = lines.map((l) => {
    if (l.kind !== 'vocal') return l
    const words: (AiWord | null)[] = [...l.words]
    // Last word first, so splicing in multi-word replacements never shifts an index still to be edited.
    const mine = plan.edits.filter((e) => e.line_id === l.id).sort((a, b) => b.word_index - a.word_index)
    for (const e of mine) {
      const w = words[e.word_index]
      if (!w || chosen.some((a) => inside(w, a))) continue
      if (e.action === 'delete') { if (e.certain && silentHere(w)) { words[e.word_index] = null; changed++ } else words[e.word_index] = { ...w, flag: 'uncertain' } }
      else if (e.action === 'flag') words[e.word_index] = { ...w, flag: 'uncertain' }
      else if (e.text.trim() && e.text.trim() !== w.text && !(e.certain && heardHere(w, e.text))) words[e.word_index] = suggest(w, e.text)
      else if (e.text.trim() && e.text.trim() !== w.text) {
        const parts = e.text.trim().split(/\s+/)
        const total = parts.reduce((s, p) => s + p.length, 0)
        let t = w.start
        const repl = parts.map((p) => {
          const d = ((w.end - w.start) * p.length) / total
          const nw: AiWord = { ...w, text: p, start: t, end: t + d, flag: 'corrected', confidence: Math.max(w.confidence, 0.6), alts: withAlt(w.alts, w.text) }
          t += d
          return nw
        })
        words.splice(e.word_index, 1, ...repl)
        changed++
      }
    }
    return { ...l, words: words.filter((w): w is AiWord => !!w) }
  })

  for (const a of chosen) {
    out = out.map((l) => (l.kind === 'vocal' ? { ...l, words: l.words.filter((w) => !inside(w, a)) } : l))
    const add = a.words.filter((w) => inside(w, a)).map((w) => ({ ...w, flag: 'corrected' as const }))
    if (!add.length) continue
    changed += add.length
    out.push({ id: newId(), kind: 'vocal', start: add[0].start, end: add[add.length - 1].end, words: add })
  }
  return { lines: out, changed }
}

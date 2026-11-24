import { memo, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Check, Download, Hand, Merge, Pause, Play, Plus, Redo2, Save, ScissorsLineDashed, ShieldCheck, Trash2, Undo2, WrapText,
} from 'lucide-react'
import { AccuracyScore, accuracyScore, AiLine, AiWord, allWords, buildLines, labelSections, lrcTime, newId, tapLine, tidyLines } from '../../electron/timed'
import { AiLyrics, api, ExportFormat, Song } from '../api'
import Waveform from './Waveform'
import { lrcToPlain } from '../../electron/parse'
import { Button, cx, IconButton, Kbd, Menu, Segmented, Spinner, Toast } from '../ui'

type Sel = { line: string; word: number | null } | null
const EXPORTS: [ExportFormat, string, string][] = [
  ['ai-lrc', 'LRC', 'Line-timed lyrics'], ['elrc', 'Enhanced LRC', 'Word-timed karaoke'], ['srt', 'SRT', 'Subtitles'],
  ['json', 'JSON', 'Words, timings & confidence'], ['ai-txt', 'TXT', 'Plain lyrics'],
]

interface Props { song: Song; ai: AiLyrics; peaks: number[] | null; onSave: (ai: AiLyrics) => Promise<void>; onDirty: (d: boolean) => void; startTap?: boolean; onEmbed?: () => void; startDirty?: boolean }

export default function Editor({ song, ai, peaks, onSave, onDirty, startTap, onEmbed, startDirty }: Props) {
  const [lines, setLines] = useState(ai.lines)
  const [past, setPast] = useState<AiLine[][]>([])
  const [future, setFuture] = useState<AiLine[][]>([])
  const [dirty, setDirty] = useState(!!startDirty) // imported or newly started timing exists only here until saved
  const [saving, setSaving] = useState(false)
  const [sel, setSel] = useState<Sel>(null)
  const [mode, setMode] = useState<'word' | 'line'>('word')
  const [source, setSource] = useState<'original' | 'vocals'>('original')
  const [rate, setRate] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [now, setNow] = useState(0)
  const [active, setActive] = useState({ line: -1, word: -1 })
  const [audioErr, setAudioErr] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [details, setDetails] = useState(false) // narrow editors show the overview only on request
  const [toast, setToast] = useState<string | null>(null)
  const [tapIdx, setTapIdx] = useState<number | null>(null) // index into vocal lines while tap-to-sync is on
  const audio = useRef<HTMLAudioElement>(null)
  const playUntil = useRef<number | null>(null)
  const lastWheel = useRef(0)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const linesRef = useRef(lines)
  linesRef.current = lines

  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])

  // ---- draft recovery ----
  // Unsaved edits are kept on this PC while you work. Leaving the editor on purpose removes them; a crash or a closed
  // window doesn't, so the next time this song opens the edits can be restored.
  const draftKey = `verse-draft:${song.id}:${ai.createdAt}`
  const [draft, setDraft] = useState<{ lines: AiLine[]; at: number } | null>(() => {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) ?? 'null') as { lines: AiLine[]; at: number } | null
      return d && Array.isArray(d.lines) && JSON.stringify(d.lines) !== JSON.stringify(ai.lines) ? d : null
    } catch { return null }
  })
  useEffect(() => {
    if (!dirty) { try { localStorage.removeItem(draftKey) } catch { /* storage unavailable */ } return }
    const t = setTimeout(() => { try { localStorage.setItem(draftKey, JSON.stringify({ lines, at: Date.now() })) } catch { /* storage full or unavailable */ } }, 600)
    return () => clearTimeout(t)
  }, [dirty, lines, draftKey])
  useEffect(() => () => { try { localStorage.removeItem(draftKey) } catch { /* storage unavailable */ } }, [draftKey])
  const restoreDraft = () => { if (draft) { commit(draft.lines); setDraft(null); flash('Unsaved edits restored') } }
  const discardDraft = () => { try { localStorage.removeItem(draftKey) } catch { /* storage unavailable */ } setDraft(null) }
  useEffect(() => () => onDirty(false), [onDirty])

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 1800) }

  const commit = useCallback((next: AiLine[]) => {
    setPast((p) => [...p.slice(-80), linesRef.current])
    setFuture([])
    setLines(labelSections(tidyLines(next)))
    setDirty(true)
  }, [])
  const undo = () => { if (!past.length) return; setFuture((f) => [lines, ...f]); setLines(past[past.length - 1]); setPast((p) => p.slice(0, -1)); setDirty(true) }
  const redo = () => { if (!future.length) return; setPast((p) => [...p, lines]); setLines(future[0]); setFuture((f) => f.slice(1)); setDirty(true) }

  const save = async () => {
    setSaving(true)
    try { await onSave({ ...ai, lines }); setDirty(false); flash('Saved to your library') }
    catch (e) { flash((e as Error).message) } finally { setSaving(false) }
  }

  // ---- playback ----
  const flat = useMemo(() => lines.flatMap((l, li) => l.words.map((w, wi) => ({ li, wi, start: w.start, end: w.end }))), [lines])
  const flatRef = useRef(flat)
  flatRef.current = flat

  const follow = useCallback((t: number) => {
    const a = audio.current
    if (a && playUntil.current !== null && t >= playUntil.current) { a.pause(); playUntil.current = null }
    const fl = flatRef.current, ls = linesRef.current
    let lo = 0, hi = fl.length - 1, i = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (fl[m].start <= t + 0.03) { i = m; lo = m + 1 } else hi = m - 1 }
    const f = fl[i], next = fl[i + 1]
    // A word stays lit until the next one starts, unless the singer stops for a while.
    const lit = !!f && (t <= f.end + 0.25 || (!!next && t < next.start && next.start - f.end < 1.2))
    const ln = ls.findLastIndex((l) => l.start <= t + 0.03)
    const n = { line: lit ? f.li : ln >= 0 && t <= ls[ln].end + 0.5 ? ln : -1, word: lit ? f.wi : -1 }
    setActive((p) => (p.line === n.line && p.word === n.word ? p : n))
  }, [])

  // rAF gives smooth highlighting; timeupdate (below) keeps it going when the window is in the background.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => { if (audio.current) follow(audio.current.currentTime); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, follow])
  useEffect(() => { if (audio.current) follow(audio.current.currentTime) }, [lines, follow])

  useEffect(() => {
    if (!playing || active.line < 0 || Date.now() - lastWheel.current < 4000) return
    centerInList(rowRefs.current.get(lines[active.line]?.id))
  }, [active.line, playing])

  useEffect(() => { if (audio.current) audio.current.playbackRate = rate }, [rate])

  const seek = useCallback((t: number) => {
    const a = audio.current
    if (!a) return
    a.currentTime = Math.max(0, Math.min(t, ai.durationSec))
    setNow(a.currentTime)
  }, [ai.durationSec])
  const toggle = () => { const a = audio.current; if (!a) return; playUntil.current = null; if (a.paused) a.play().catch((e) => setAudioErr(e.message)); else a.pause() }
  const playRange = (s: number, e: number) => { const a = audio.current; if (!a) return; seek(Math.max(0, s - 0.05)); playUntil.current = e + 0.05; a.play().catch(() => {}) }

  const switchSource = (s: 'original' | 'vocals') => {
    const a = audio.current
    if (!a || s === source) return
    const t = a.currentTime, was = !a.paused
    setSource(s)
    a.addEventListener('loadedmetadata', () => { a.currentTime = t; a.playbackRate = rate; if (was) a.play().catch(() => {}) }, { once: true })
  }

  // ---- selection helpers ----
  const selLine = sel ? lines.find((l) => l.id === sel.line) : undefined
  const selWord = selLine && sel?.word !== null && sel?.word !== undefined ? selLine.words[sel.word] : undefined
  const pick = useCallback((lineId: string, word: number | null, t?: number) => { setSel({ line: lineId, word }); if (t !== undefined) seek(t) }, [seek])

  const updateWord = (patch: Partial<AiWord> | ((w: AiWord) => AiWord[])) => {
    if (!selLine || sel?.word === null || sel?.word === undefined) return
    const wi = sel.word
    const repl = typeof patch === 'function' ? patch(selLine.words[wi]) : [{ ...selLine.words[wi], ...patch }]
    const next = lines.map((l) => (l.id === selLine.id ? { ...l, words: [...l.words.slice(0, wi), ...repl, ...l.words.slice(wi + 1)] } : l))
    commit(next)
    // Timing edits can reorder words; keep the selection on the edited word, not its old position.
    const moved = repl.length ? tidyLines(next).find((l) => l.id === selLine.id)?.words.indexOf(repl[0]) ?? -1 : -1
    setSel({ line: selLine.id, word: moved >= 0 ? moved : null })
  }
  const setText = (text: string) => updateWord((w) => {
    const parts = text.trim().split(/\s+/).filter(Boolean)
    if (!parts.length) return []
    const total = parts.reduce((s, p) => s + p.length, 0)
    let t = w.start
    return parts.map((p) => { const d = ((w.end - w.start) * p.length) / total; const nw = { ...w, text: p, start: t, end: t + d, edited: true, flag: undefined, confidence: 1 }; t += d; return nw })
  })
  const setTime = (which: 'start' | 'end', v: number) => {
    if (!selWord || !Number.isFinite(v)) return
    const t = Math.max(0, Math.min(v, ai.durationSec))
    updateWord(which === 'start' ? { start: Math.min(t, selWord.end - 0.02), edited: true } : { end: Math.max(t, selWord.start + 0.02), edited: true })
  }
  const shiftLine = (which: 'start' | 'end', v: number) => {
    if (!selLine || !Number.isFinite(v)) return
    if (selLine.kind === 'instrumental') { commit(lines.map((l) => (l.id === selLine.id ? { ...l, [which]: Math.max(0, v) } : l))); return }
    if (which === 'start') {
      const d = Math.max(0, v) - selLine.start
      commit(lines.map((l) => (l.id === selLine.id ? { ...l, words: l.words.map((w) => ({ ...w, start: w.start + d, end: w.end + d, edited: true })) } : l)))
    } else {
      // Moving a line's end stretches its words proportionally from the line start.
      const span = selLine.end - selLine.start, k = Math.max(0.05, v - selLine.start) / (span || 1)
      commit(lines.map((l) => (l.id === selLine.id ? { ...l, words: l.words.map((w) => ({ ...w, start: l.start + (w.start - l.start) * k, end: l.start + (w.end - l.start) * k, edited: true })) } : l)))
    }
  }
  const addLineAfter = (id: string) => {
    const i = lines.findIndex((l) => l.id === id)
    const prev = lines[i], next = lines[i + 1]
    const a = audio.current?.currentTime ?? 0
    let start = a > prev.end && (!next || a < next.start) ? a : prev.end + 0.05
    const end = Math.min(start + 1.5, next ? next.start - 0.02 : ai.durationSec)
    if (end - start < 0.1) start = Math.max(prev.end, end - 0.3)
    const nl: AiLine = { id: newId(), kind: 'vocal', start, end, words: [{ text: '…', start, end, confidence: 1, edited: true }] }
    commit([...lines.slice(0, i + 1), nl, ...lines.slice(i + 1)])
    setSel({ line: nl.id, word: 0 })
    setTimeout(() => document.getElementById('word-text')?.focus(), 30)
  }
  const deleteLine = (id: string) => { commit(lines.filter((l) => l.id !== id)); setSel(null) }
  const splitAfter = () => {
    if (!selLine || sel?.word == null || sel.word >= selLine.words.length - 1) return
    const a = selLine.words.slice(0, sel.word + 1), b = selLine.words.slice(sel.word + 1)
    commit(lines.flatMap((l) => (l.id === selLine.id ? [{ ...l, words: a }, { ...l, id: newId(), words: b, section: undefined }] : [l])))
  }
  const mergeNext = () => {
    if (!selLine) return
    const i = lines.indexOf(selLine), next = lines.slice(i + 1).find((l) => l.kind === 'vocal')
    if (!next || selLine.kind !== 'vocal') return
    commit(lines.filter((l) => l.id !== next.id).map((l) => (l.id === selLine.id ? { ...l, words: [...l.words, ...next.words] } : l)))
  }
  const insertWordAfter = () => {
    if (!selLine || !selWord || sel?.word == null) return
    const nextW = selLine.words[sel.word + 1]
    const start = selWord.end, end = Math.min(nextW ? nextW.start : start + 0.4, start + 0.4)
    commit(lines.map((l) => (l.id === selLine.id ? { ...l, words: [...l.words.slice(0, sel.word! + 1), { text: '…', start, end: Math.max(end, start + 0.05), confidence: 1, edited: true, speaker: selWord.speaker }, ...l.words.slice(sel.word! + 1)] } : l)))
    setSel({ line: selLine.id, word: sel.word + 1 })
    setTimeout(() => document.getElementById('word-text')?.focus(), 30)
  }
  const reference = song.plainLyrics || (song.syncedLyrics ? lrcToPlain(song.syncedLyrics) : undefined)
  const accuracy = useMemo(() => accuracyScore(lines, reference), [lines, reference])
  const uncertain = useMemo(() => lines.flatMap((l) => l.words.map((w, wi) => ({ l, w, wi }))).filter((x) => needsReview(x.w)), [lines])
  const nextUncertain = () => {
    if (!uncertain.length) return
    const t = selWord?.start ?? audio.current?.currentTime ?? 0
    const n = uncertain.find((x) => x.w.start > t + 0.01) ?? uncertain[0]
    pick(n.l.id, n.wi, n.w.start)
    playRange(n.w.start - 0.4, n.w.end + 0.4)
    centerInList(rowRefs.current.get(n.l.id))
  }
  // Review keys on a selected word: A accept, U mark unclear, 1-9 take a suggestion, N next.
  const review = (fn: () => void) => { fn(); setTimeout(nextUncertain, 0) }

  // Older analyses (and edits) can leave lines cut mid-phrase; rebuild them from the words, keeping every word as is.
  const resplit = () => {
    const words = lines.flatMap((l) => l.words.map((w) => (l.backing && !w.backing ? { ...w, backing: true } : w)))
    commit(labelSections(buildLines(words, { durationSec: ai.durationSec })))
    setSel(null)
    flash('Line breaks fixed. Press Ctrl+Z to undo.')
  }

  // ---- tap-to-sync ----
  const vocalLines = lines.filter((l) => l.kind === 'vocal')
  const startTapping = () => {
    const from = Math.max(0, vocalLines.findIndex((l) => l.id === sel?.line))
    setTapIdx(from)
    const a = audio.current
    // Start just after the previous line so the first tap has a run-up.
    if (a) { seek(from ? vocalLines[from - 1].start : 0); a.play().catch(() => {}) }
  }
  const tap = () => {
    const a = audio.current
    if (tapIdx === null || !a) return
    commit(tapLine(lines, tapIdx, a.currentTime))
    if (tapIdx + 1 >= vocalLines.length) { setTapIdx(null); flash('Every line is timed. Fine-tune words, then save.') }
    else setTapIdx(tapIdx + 1)
  }
  const stepBack = () => {
    if (!tapIdx) return
    const prev = vocalLines[tapIdx - 1]
    setTapIdx(tapIdx - 1)
    seek(Math.max(0, prev.start - 2))
  }
  useEffect(() => { if (startTap) startTapping() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tapIdx !== null && !/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tap(); return }
        if (e.key === 'Escape') { setTapIdx(null); return }
        if (e.key === 'Backspace') { e.preventDefault(); stepBack(); return }
      }
      const tag = (e.target as HTMLElement).tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) save(); return }
      if (typing) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
      if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); toggle() }
      else if (e.key === '[' && selWord) setTime('start', audio.current?.currentTime ?? 0)
      else if (e.key === ']' && selWord) setTime('end', audio.current?.currentTime ?? 0)
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selWord) updateWord(() => [])
      else if (e.key === 'n' || e.key === 'N') nextUncertain()
      else if ((e.key === 'a' || e.key === 'A') && selWord) review(() => updateWord({ flag: undefined, confidence: 1, edited: true }))
      else if ((e.key === 'u' || e.key === 'U') && selWord) review(() => updateWord({ text: UNCLEAR, heard: selWord.heard ?? selWord.text, flag: 'uncertain', edited: true }))
      else if (/^[1-9]$/.test(e.key) && selWord?.alts?.[+e.key - 1]) review(() => setText(selWord.alts![+e.key - 1]))
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && sel) {
        const i = flat.findIndex((f) => lines[f.li].id === sel.line && f.wi === (sel.word ?? 0))
        const n = flat[i + (e.key === 'ArrowRight' ? 1 : -1)]
        if (n) { e.preventDefault(); pick(lines[n.li].id, n.wi, n.start) }
      } else if (e.key === 'Escape') setSel(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const doExport = async (f: ExportFormat) => {
    setMenu(false)
    try { if (await api.exportLyrics({ ...song, ai: { ...ai, lines } }, f)) flash("exported, let's gooo 🎉") } catch (e) { flash((e as Error).message) }
  }

  const speakers = useMemo(() => [...new Set(allWords(lines).map((w) => w.speaker).filter(Boolean))] as string[], [lines])
  const src = source === 'vocals' && ai.vocalsUrl ? ai.vocalsUrl : song.audioUrl
  const regions = useMemo(() => lines.filter((l) => l.kind === 'vocal').map((l) => ({ start: l.start, end: l.end, uncertain: l.words.some((w) => w.flag === 'uncertain') })), [lines])
  const activeRegions = useMemo(() => regions.map((r, i) => ({ ...r, active: lines.filter((l) => l.kind === 'vocal')[i] === lines[active.line] })), [regions, active.line, lines])

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      {/* player: transport, tools and waveform in one glass panel */}
      <section className="glass enter-2 relative z-20 mb-4 rounded-[20px] p-3" aria-label="Player">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={toggle} disabled={!src} aria-label={playing ? 'Pause' : 'Play'} className="btn-play size-10">
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} className="ml-0.5" fill="currentColor" />}
        </button>
        <span className="tabular mr-1.5 ml-1 font-mono text-[12.5px] whitespace-nowrap text-white/75">{lrcTime(now)} <span className="text-white/30">/ {lrcTime(ai.durationSec).slice(0, 5)}</span></span>
        {ai.vocalsUrl && (
          <Segmented value={source} onChange={(v) => switchSource(v)} label="Audio source" items={[['original', 'Original'], ['vocals', 'Vocals']]} />
        )}
        <Button variant="ghost" size="sm" className="tabular w-12" tip="Playback speed" aria-label={`Playback speed ${rate}×, click to change`}
          onClick={() => setRate(rate === 1 ? 0.75 : rate === 0.75 ? 0.5 : 1)}>{rate}×</Button>
        <Segmented value={mode} onChange={setMode} label="Timing level" items={[['word', 'Words'], ['line', 'Lines']]} />
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => { setSel(null); setDetails((d) => !d) }} aria-pressed={details} className="mr-1.5 flex h-8 items-center gap-2 rounded-full bg-white/[0.06] py-1 pr-3 pl-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] hover:bg-white/[0.1]" data-tip={`Estimated accuracy ${accuracy.score}%. Click for details`} aria-label={`Estimated accuracy ${accuracy.score} percent. Show details`}>
            <AccuracyRing value={accuracy.score} size={24} stroke={3} />
            <span className="tabular text-[12px] font-semibold text-fg">{accuracy.score}%</span>
          </button>
          <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!past.length}><Undo2 size={15} /></IconButton>
          <IconButton label="Redo (Ctrl+Y)" onClick={redo} disabled={!future.length}><Redo2 size={15} /></IconButton>
          <IconButton label="Fix line breaks: re-split lines at natural phrase breaks. Words and timings are kept (Ctrl+Z undoes)" onClick={resplit}><WrapText size={15} /></IconButton>
          <span className="mx-1.5 h-5 w-px bg-white/[0.1]" aria-hidden />
          <Button variant={tapIdx !== null ? 'primary' : 'ghost'} aria-pressed={tapIdx !== null} icon={<Hand size={14} />}
            tip="Play the song and press Space as each line starts" onClick={() => (tapIdx === null ? startTapping() : setTapIdx(null))}>
            <span className={tapIdx !== null ? undefined : '@max-[1080px]:sr-only'}>{tapIdx !== null ? 'Stop tapping' : 'Tap to sync'}</span>
          </Button>
          {uncertain.length > 0 && (
            <Button variant="ghost" onClick={nextUncertain} tip="Play the next word the AI wasn't sure about (N)" icon={<span className="size-1.5 rounded-full bg-warn shadow-[0_0_8px_var(--warn)]" />}>
              <span className="tabular">{uncertain.length}</span> to review
            </Button>
          )}
          <div className="relative">
            <Button variant="ghost" tip="Export" icon={<Download size={14} />} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}><span className="@max-[1080px]:sr-only">Export</span></Button>
            {menu && (
              <Menu onClose={() => setMenu(false)} align="right" width="w-64">
                {EXPORTS.map(([f, n, d]) => (
                  <button key={f} role="menuitem" onClick={() => doExport(f)} className="flex w-full items-baseline justify-between gap-3 rounded-[9px] px-2.5 py-2 text-left hover:bg-white/[0.09] focus-visible:bg-white/[0.09]">
                    <span className="text-[13px] font-medium">{n}</span><span className="text-[11px] text-subtle">{d}</span>
                  </button>
                ))}
                {onEmbed && (
                  <>
                    <div className="mx-1.5 my-1.5 h-px bg-white/[0.08]" />
                    <button role="menuitem" onClick={() => { setMenu(false); if (dirty) flash('Save your changes first, so the export includes them.'); else onEmbed() }}
                      className="flex w-full items-baseline justify-between gap-3 rounded-[9px] px-2.5 py-2 text-left hover:bg-white/[0.09] focus-visible:bg-white/[0.09]">
                      <span className="text-[13px] font-medium">Embed into audio file…</span><span className="text-[11px] text-subtle">Exports a copy</span>
                    </button>
                  </>
                )}
              </Menu>
            )}
          </div>
          {dirty && !saving && <span className="mr-1 flex h-7 items-center gap-1.5 rounded-full bg-warn/[0.12] px-2.5 text-[12px] font-medium text-warn" role="status"><span className="size-1.5 rounded-full bg-warn" aria-hidden />Unsaved changes</span>}
          <Button variant={dirty ? 'primary' : 'secondary'} onClick={save} disabled={!dirty || saving} tip="Ctrl+S"
            icon={saving ? <Spinner size={14} className="text-accent-fg" /> : dirty ? <Save size={14} /> : <Check size={14} />}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </Button>
        </div>
      </div>
      <Waveform peaks={peaks} durationSec={ai.durationSec} audio={audio} regions={activeRegions} onSeek={seek} height={52} />
      </section>

      {draft && (
        <div className="pop mb-4 flex flex-wrap items-center gap-3 rounded-[16px] border border-warn/30 bg-[rgb(60_44_14/0.55)] px-4 py-3 text-[13px] backdrop-blur-xl" role="alert">
          <AlertTriangle size={15} className="shrink-0 text-warn" />
          <span className="flex-1">Verse closed before your last edits to this song were saved ({new Date(draft.at).toLocaleString()}).</span>
          <Button size="sm" variant="primary" onClick={restoreDraft}>Restore edits</Button>
          <Button size="sm" variant="ghost" onClick={discardDraft}>Discard</Button>
        </div>
      )}
      {src && <audio ref={audio} src={src} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => { setNow(e.currentTarget.currentTime); follow(e.currentTarget.currentTime) }} onSeeked={(e) => follow(e.currentTarget.currentTime)} onError={() => setAudioErr(source === 'vocals' ? 'the vocal track went missing 🫥 re-run the analysis to get it back.' : 'the audio file got moved or deleted, so no playback. rip 🪦')} />}
      {audioErr && <p className="mt-2 text-[12px] text-bad">{audioErr}</p>}
      {tapIdx !== null && vocalLines[tapIdx] && (
        <div className="pop mb-4 flex items-center gap-4 rounded-[18px] border border-accent/30 bg-[rgb(40_33_20/0.75)] px-5 py-4 backdrop-blur-xl" role="status" aria-live="polite">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
              <span className="tabular font-medium text-accent">Line {tapIdx + 1} of {vocalLines.length}</span>·
              <span>Press <Kbd>Space</Kbd> as it starts</span>·<span><Kbd>Backspace</Kbd> back</span>·<span><Kbd>Esc</Kbd> stop</span>
            </div>
            <div className="mt-1.5 truncate text-[19px] font-bold tracking-[-0.02em]">{vocalLines[tapIdx].words.map((w) => w.text).join(' ')}</div>
            {vocalLines[tapIdx + 1] && <div className="truncate text-[13px] text-muted">Next: {vocalLines[tapIdx + 1].words.map((w) => w.text).join(' ')}</div>}
          </div>
          <Button variant="primary" size="lg" className="px-8" onClick={tap}>Tap</Button>
        </div>
      )}
      {ai.notes.length > 0 && (
        <ul className="mb-4 space-y-1.5 rounded-[14px] border border-white/[0.07] bg-white/[0.03] px-4 py-3 text-[12px] text-muted">
          {ai.notes.map((n, i) => <li key={i} className="flex gap-2.5"><AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />{n}</li>)}
        </ul>
      )}

      {/* Wide: lyrics beside a column of inspector cards. Narrow: the inspector sits below, and only when there is something to inspect. */}
      <div className={cx('grid min-h-0 flex-1 gap-4 @min-[820px]:grid-cols-[minmax(0,1fr)_300px] @min-[820px]:grid-rows-1 @min-[820px]:gap-6', sel || details ? 'grid-rows-[minmax(0,1fr)_minmax(0,42%)]' : 'grid-rows-[minmax(0,1fr)]')}>
        <div className="selectable relative -mx-2 min-h-0 overflow-y-auto px-2 pb-8 [mask-image:linear-gradient(180deg,#000_0,#000_calc(100%-64px),transparent)] @min-[820px]:pb-[30vh]" onWheel={() => { lastWheel.current = Date.now() }} role="list" aria-label="Reconstructed lyrics">
          {lines.map((l, li) => (
            <LineRow key={l.id} line={l} index={li} mode={mode} active={active.line === li} activeWord={active.line === li ? active.word : -1}
              selected={sel?.line === l.id ? sel.word : undefined} speakerNo={l.speaker ? speakers.indexOf(l.speaker) + 1 : 0}
              showSpeaker={!!l.speaker && speakers.length > 1 && lines.slice(0, li).findLast((x) => x.kind === 'vocal')?.speaker !== l.speaker}
              refCb={(el) => { if (el) rowRefs.current.set(l.id, el); else rowRefs.current.delete(l.id) }}
              onPick={pick} onPlay={playRange} onAdd={addLineAfter} onDelete={deleteLine} />
          ))}
        </div>

        <aside className={cx('min-h-0 overflow-y-auto pb-6 text-[13px]', !sel && !details && '@max-[819px]:hidden')} aria-label="Inspector">
          {selWord && selLine ? (
            <WordInspector key={`${selLine.id}:${sel!.word}:${selWord.text}`} word={selWord} line={selLine} wordIndex={sel!.word!}
              onText={setText} onTime={setTime} onPlay={() => playRange(selWord.start, selWord.end)}
              playhead={() => audio.current?.currentTime ?? 0}
              onVerify={() => review(() => updateWord({ flag: undefined, confidence: 1, edited: true }))} onDelete={() => updateWord(() => [])}
              onPickAlt={(t) => review(() => setText(t))} onUnclear={() => review(() => updateWord({ text: UNCLEAR, heard: selWord.heard ?? selWord.text, flag: 'uncertain', edited: true }))}
              onInsert={insertWordAfter} onSplit={splitAfter} onMerge={mergeNext} />
          ) : selLine ? (
            <LineInspector key={selLine.id + selLine.start} line={selLine} onTime={shiftLine} onPlay={() => playRange(selLine.start, selLine.end)}
              playhead={() => audio.current?.currentTime ?? 0} onAdd={() => addLineAfter(selLine.id)} onDelete={() => deleteLine(selLine.id)} onMerge={mergeNext} />
          ) : (
            <Overview ai={ai} lines={lines} uncertain={uncertain.length} accuracy={accuracy} />
          )}
        </aside>
      </div>
      {toast && <Toast>{toast}</Toast>}
    </div>
  )
}

interface RowProps {
  line: AiLine; index: number; mode: 'word' | 'line'; active: boolean; activeWord: number; selected: number | null | undefined; speakerNo: number; showSpeaker: boolean
  refCb: (el: HTMLDivElement | null) => void
  onPick: (lineId: string, word: number | null, t?: number) => void; onPlay: (s: number, e: number) => void; onAdd: (id: string) => void; onDelete: (id: string) => void
}

const LineRow = memo(function LineRow({ line: l, mode, active, activeWord, selected, speakerNo, showSpeaker, refCb, onPick, onPlay, onAdd, onDelete }: RowProps) {
  const lineSel = selected === null
  return (
    <div ref={refCb} role="listitem" className="group">
      {l.section && <div className="t-eyebrow mt-7 mb-2 pl-[80px]">{l.section}</div>}
      {showSpeaker && <div className="mt-3 mb-1 pl-[80px] text-[11px] font-semibold text-accent">Vocalist {speakerNo}</div>}
      <div className={cx('flex items-start gap-2 rounded-[12px] px-2.5 py-1.5 transition-colors duration-300', lineSel ? 'bg-accent-soft shadow-[inset_3px_0_0_var(--accent)]' : active ? 'bg-white/[0.07] shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]' : 'hover:bg-white/[0.035]')}>
        <button onClick={() => onPick(l.id, null, l.start)} data-tip="Select line"
          className={cx('tabular mt-[8px] w-[68px] shrink-0 text-left font-mono text-[11px] hover:text-accent', active ? 'font-medium text-accent' : 'text-white/30')}>
          {lrcTime(l.start)}
        </button>
        {l.backing && <span className="mt-[8px] shrink-0 rounded-full bg-white/[0.07] px-2 py-px text-[9.5px] font-semibold tracking-[0.08em] text-white/45 uppercase" data-tip="Backing vocal or ad-lib, exported in parentheses">Backing</span>}
        {l.kind === 'instrumental' ? (
          <button onClick={() => onPick(l.id, null, l.start)} className="flex flex-1 items-center gap-2 py-1 text-left text-[13px] font-medium text-white/35"><span className="text-[15px]">♪</span>Instrumental · {Math.round(l.end - l.start)} s</button>
        ) : (
          <div className={cx('flex flex-1 flex-wrap gap-x-0.5 gap-y-0.5 text-[17px] leading-snug font-medium', mode === 'line' && active && 'font-semibold text-fg')}>
            {l.words.map((w, wi) => {
              const isActive = mode === 'word' && active && wi === activeWord
              const sung = mode === 'word' && active && activeWord >= 0 && wi < activeWord
              return (
                <button key={wi} onClick={() => onPick(l.id, wi, w.start)}
                  title={`${lrcTime(w.start)} → ${lrcTime(w.end)} · ${Math.round(w.confidence * 100)}% confidence${w.flag === 'uncertain' ? ' · uncertain' : w.flag === 'corrected' ? ' · AI-corrected' : ''}${w.edited ? ' · edited' : ''}`}
                  className={cx('rounded-[7px] px-1.5 py-0.5 transition-colors duration-100',
                    isActive ? 'bg-accent text-accent-fg' : sung ? 'text-fg' : mode === 'line' && active ? '' : active ? 'text-white/75 hover:bg-white/[0.08] hover:text-fg' : 'text-white/58 hover:bg-white/[0.08] hover:text-fg',
                    selected === wi && 'ring-2 ring-accent/80',
                    w.flag === 'uncertain' ? 'underline decoration-warn/80 decoration-dotted decoration-2 underline-offset-[5px]'
                      : w.flag === 'corrected' && 'underline decoration-accent/50 decoration-1 underline-offset-[5px]',
                    (w.backing || l.backing) && 'italic opacity-75', w.text === UNCLEAR && 'font-mono text-[13px] text-warn')}>
                  {w.text}
                </button>
              )
            })}
          </div>
        )}
        <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconBtn label="Replay this line" onClick={() => onPlay(l.start, l.end)}><Play size={13} /></IconBtn>
          <IconBtn label="Add a line after" onClick={() => onAdd(l.id)}><Plus size={13} /></IconBtn>
          <IconBtn label="Delete line" onClick={() => onDelete(l.id)} danger><Trash2 size={13} /></IconBtn>
        </div>
      </div>
    </div>
  )
})

function WordInspector({ word: w, line, wordIndex, onText, onTime, onPlay, playhead, onVerify, onDelete, onInsert, onSplit, onMerge, onPickAlt, onUnclear }: {
  word: AiWord; line: AiLine; wordIndex: number; onText: (t: string) => void; onTime: (k: 'start' | 'end', v: number) => void; onPlay: () => void
  playhead: () => number; onVerify: () => void; onDelete: () => void; onInsert: () => void; onSplit: () => void; onMerge: () => void
  onPickAlt: (t: string) => void; onUnclear: () => void
}) {
  const [text, setText] = useState(w.text)
  const conf = Math.round(w.confidence * 100)
  return (
    <div className="card pop space-y-5 p-4">
      <div>
        <h3 className="t-eyebrow mb-2.5">Word</h3>
        <input id="word-text" value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()}
          onBlur={() => text !== w.text && onText(text)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setText(w.text) }}
          aria-label="Word text" className="field h-11 text-[18px] font-semibold tracking-[-0.01em]" />
        <p className="mt-2 text-[11px] text-subtle">Type several words to split this one. Clear it to delete.</p>
      </div>
      <div className="flex items-center gap-2.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.08]"><div className={`h-full rounded-full ${w.flag === 'uncertain' ? 'bg-gradient-to-r from-[#c98a3c] to-warn' : 'bg-gradient-to-r from-[#4fb882] to-ok'}`} style={{ width: `${conf}%` }} /></div>
        <span className="w-28 text-right text-[12px] font-medium text-muted">{w.text === UNCLEAR ? 'Marked unclear' : <>{conf}% </>}{w.text === UNCLEAR ? '' : w.verified ? '· heard twice' : w.flag === 'uncertain' ? '· uncertain' : w.flag === 'corrected' ? '· AI-corrected' : w.edited ? '· edited' : ''}</span>
      </div>
      {(w.heard && w.heard !== w.text || w.alts?.length) && (
        <div className="space-y-2.5 rounded-[12px] border border-white/[0.08] bg-black/20 p-3">
          {w.heard && w.heard !== w.text && <p className="text-[12px] text-muted">Best guess from the audio: <button className="font-medium text-fg underline decoration-dotted" onClick={() => onPickAlt(w.heard!)}>{w.heard}</button></p>}
          {!!w.alts?.length && (
            <div>
              <p className="mb-1.5 text-[11px] text-subtle">Other readings (from a second listen, the published lyrics, a chorus repeat or Claude). Only take one if it's what you hear.</p>
              <div className="flex flex-wrap gap-1.5">
                {w.alts.map((a, i) => (
                  <button key={a} onClick={() => onPickAlt(a)} className="flex items-center gap-1.5 rounded-full bg-white/[0.07] py-1 pr-3 pl-1.5 text-[13px] font-medium ring-1 ring-white/[0.08] hover:bg-white/[0.12] hover:ring-accent/50">
                    {i < 9 && <Kbd>{i + 1}</Kbd>} {a}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <TimeField label="Start" value={w.start} onChange={(v) => onTime('start', v)} playhead={playhead} shortcut="[" />
      <TimeField label="End" value={w.end} onChange={(v) => onTime('end', v)} playhead={playhead} shortcut="]" />
      <div className="grid grid-cols-2 gap-2">
        <Action onClick={onPlay} icon={<Play size={13} />}>Play word</Action>
        <Action onClick={onVerify} icon={<ShieldCheck size={13} />} disabled={w.flag !== 'uncertain' && w.confidence >= 1}>Mark correct</Action>
        <Action onClick={onInsert} icon={<Plus size={13} />}>Insert after</Action>
        <Action onClick={onSplit} icon={<ScissorsLineDashed size={13} />} disabled={wordIndex >= line.words.length - 1}>New line after</Action>
        <Action onClick={onMerge} icon={<Merge size={13} />}>Join next line</Action>
        <Action onClick={onUnclear} icon={<AlertTriangle size={13} />} disabled={w.text === UNCLEAR}>Mark unclear</Action>
        <Action onClick={onDelete} icon={<Trash2 size={13} />} danger>Delete word</Action>
      </div>
      {w.speaker && <p className="text-[12px] text-muted">Speaker label: {w.speaker}</p>}
    </div>
  )
}

function LineInspector({ line: l, onTime, onPlay, playhead, onAdd, onDelete, onMerge }: {
  line: AiLine; onTime: (k: 'start' | 'end', v: number) => void; onPlay: () => void; playhead: () => number; onAdd: () => void; onDelete: () => void; onMerge: () => void
}) {
  return (
    <div className="card pop space-y-5 p-4">
      <h3 className="t-eyebrow">{l.kind === 'instrumental' ? 'Instrumental section' : 'Line'}</h3>
      {l.kind === 'vocal' && <p className="text-[16px] leading-snug font-semibold tracking-[-0.01em]">{l.words.map((w) => w.text).join(' ')}</p>}
      <TimeField label={l.kind === 'vocal' ? 'Start (moves all words)' : 'Start'} value={l.start} onChange={(v) => onTime('start', v)} playhead={playhead} />
      <TimeField label={l.kind === 'vocal' ? 'End (stretches words)' : 'End'} value={l.end} onChange={(v) => onTime('end', v)} playhead={playhead} />
      <div className="grid grid-cols-2 gap-2">
        <Action onClick={onPlay} icon={<Play size={13} />}>Replay line</Action>
        <Action onClick={onAdd} icon={<Plus size={13} />}>Add line after</Action>
        {l.kind === 'vocal' && <Action onClick={onMerge} icon={<Merge size={13} />}>Join next line</Action>}
        <Action onClick={onDelete} icon={<Trash2 size={13} />} danger>Delete line</Action>
      </div>
    </div>
  )
}

const tone = (v: number) => (v >= 90 ? 'var(--ok)' : v >= 70 ? 'var(--warn)' : 'var(--bad)')

const RING: Record<string, [string, string]> = { 'var(--ok)': ['#4fb882', '#b5f5d6'], 'var(--warn)': ['#c98a3c', '#ffe0a3'], 'var(--bad)': ['#c9495a', '#ffb3b3'] }
function AccuracyRing({ value, size, stroke, children }: { value: number; size: number; stroke: number; children?: ReactNode }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r
  const [from, to] = RING[tone(value)]
  const id = `ring-${size}-${tone(value).slice(6, -1)}`
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" style={{ filter: size > 40 ? `drop-shadow(0 0 10px ${from}66)` : undefined }} aria-hidden>
        <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={to} /><stop offset="1" stopColor={from} /></linearGradient></defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.1)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${id})`} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(100, value)) / 100)} style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.22, 1, 0.36, 1)' }} />
      </svg>
      {children && <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>}
    </div>
  )
}

function AccuracyCard({ a }: { a: AccuracyScore }) {
  const label = a.score >= 90 ? 'High' : a.score >= 70 ? 'Fair: worth a review' : 'Low: needs review'
  const pct = (n: number) => (a.words ? Math.round((n / a.words) * 100) : 0)
  return (
    <section className="card p-5" aria-label="Estimated accuracy">
      <div className="flex items-center gap-4">
        <AccuracyRing value={a.score} size={96} stroke={8}>
          <span className="tabular text-[25px] leading-none font-bold tracking-[-0.03em] text-fg">{a.score}<span className="text-[13px] font-semibold text-muted">%</span></span>
        </AccuracyRing>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold tracking-tight text-fg">Estimated accuracy</div>
          <div className="mt-0.5 text-[12px] font-medium" style={{ color: tone(a.score) }}>{label}</div>
          {a.reference !== undefined && <div className="mt-1.5 text-[12px] text-muted"><span className="tabular font-medium text-fg">{a.reference}%</span> agreement with the published lyrics</div>}
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-white/[0.07] pt-3.5 text-[12px]">
        <dt>Heard twice</dt><dd className="tabular text-right text-fg/80">{pct(a.heardTwice)}%</dd>
        <dt>Checked by you</dt><dd className="tabular text-right text-fg/80">{pct(a.checked)}%</dd>
        <dt>To review</dt><dd className="tabular text-right text-fg/80">{a.toReview}</dd>
        <dt>Unclear</dt><dd className="tabular text-right text-fg/80">{a.unclear}</dd>
      </dl>
      <p className="mt-3 text-[11px] leading-relaxed text-subtle">
        An estimate, not a check against the real lyrics: each word counts with the recogniser's confidence, words you've checked or edited count as right and [unclear] as wrong. Review flagged words to raise it.
        {a.reference !== undefined && ' Published lyrics can differ from the recording (ad-libs, edits, wrong version), so 100% agreement isn’t expected.'}
      </p>
    </section>
  )
}

function Overview({ ai, lines, uncertain, accuracy }: { ai: AiLyrics; lines: AiLine[]; uncertain: number; accuracy: AccuracyScore }) {
  const words = allWords(lines)
  return (
    <div className="space-y-4 text-muted">
      <AccuracyCard a={accuracy} />
      <div className="grid grid-cols-3 gap-2 text-center">
        {[['Words', words.length], ['Lines', lines.filter((l) => l.kind === 'vocal').length], ['Uncertain', uncertain]].map(([k, v]) => (
          <div key={k} className="rounded-[14px] border border-white/[0.06] bg-white/[0.035] py-3"><div className="tabular text-[20px] font-bold tracking-[-0.02em] text-fg">{v}</div><div className="mt-0.5 text-[11px] font-medium">{k}</div></div>
        ))}
      </div>
      <p className="px-1 text-[12px] leading-relaxed">Click a word to jump there and edit it. Click a timestamp to select the whole line. <span className="text-warn">Dotted</span> words are ones the AI wasn't sure about; <span className="text-accent">underlined</span> words were changed because a second listen heard them. <span className="font-mono text-warn">[unclear]</span> marks words too faint to guess; <i>italic</i> lines are backing vocals.</p>
      <dl className="card space-y-2 p-4 text-[12px]">
        <Row k="Transcription" v={ai.providers.transcription} />
        {ai.providers.separation && <Row k="Separation" v={ai.providers.separation} />}
        {ai.providers.refinement && <Row k="Refinement" v={ai.providers.refinement} />}
        {ai.language && <Row k="Language" v={ai.language} />}
        <Row k="Analysed" v={new Date(ai.createdAt).toLocaleString()} />
      </dl>
      <div className="rounded-[14px] border border-white/[0.07] bg-black/20 p-4 text-[11px] leading-[1.8]">
        <div className="t-eyebrow mb-1.5">Shortcuts</div>
        Space play/pause · N next word to review (plays it) · A accept · U mark unclear · 1–9 take a suggestion · ←/→ previous/next word · [ / ] set start/end to playhead · Delete remove word · Ctrl+Z undo · Ctrl+S save
      </div>
    </div>
  )
}

// Centres a row in the lyrics list without scrolling anything else on the page (scrollIntoView would).
function centerInList(el?: HTMLElement | null) {
  const box = el?.closest<HTMLElement>('[role=list]')
  if (el && box) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' })
}

const UNCLEAR = '[unclear]'
const needsReview = (w: AiWord) => w.flag === 'uncertain' || w.text === UNCLEAR

const Row = ({ k, v }: { k: string; v: string }) => <div className="flex gap-2"><dt className="w-24 shrink-0">{k}</dt><dd className="text-fg/80">{v}</dd></div>

function TimeField({ label, value, onChange, playhead, shortcut }: { label: string; value: number; onChange: (v: number) => void; playhead: () => number; shortcut?: string }) {
  const [v, setV] = useState(value.toFixed(2))
  useEffect(() => setV(value.toFixed(2)), [value])
  const commitV = () => { const n = parseFloat(v); if (Number.isFinite(n) && Math.abs(n - value) > 0.0005) onChange(n); else setV(value.toFixed(2)) }
  return (
    <div>
      <div className="mb-2 flex justify-between text-[12px] font-medium text-muted"><span>{label}</span><span className="font-mono text-white/45">{lrcTime(value)}</span></div>
      <div className="flex gap-1.5">
        <button onClick={() => onChange(value - 0.05)} className="h-9 shrink-0 rounded-[10px] bg-white/[0.06] px-2.5 text-[11px] font-medium text-muted hover:bg-white/[0.1] hover:text-fg" aria-label={`${label} 50 ms earlier`}>−50ms</button>
        <input value={v} onChange={(e) => setV(e.target.value)} onBlur={commitV} onKeyDown={(e) => e.key === 'Enter' && commitV()} inputMode="decimal" aria-label={`${label} in seconds`}
          className="field min-w-0 text-center font-mono tabular-nums" />
        <button onClick={() => onChange(value + 0.05)} className="h-9 shrink-0 rounded-[10px] bg-white/[0.06] px-2.5 text-[11px] font-medium text-muted hover:bg-white/[0.1] hover:text-fg" aria-label={`${label} 50 ms later`}>+50ms</button>
      </div>
      <button onClick={() => onChange(playhead())} className="mt-2 text-[11px] font-medium text-accent hover:underline">Set to playhead{shortcut ? ` (${shortcut})` : ''}</button>
    </div>
  )
}

function IconBtn({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return <IconButton label={label} size="sm" tipLeft onClick={onClick} disabled={disabled} variant={danger ? 'danger' : 'ghost'}>{children}</IconButton>
}

function Action({ onClick, icon, children, disabled, danger }: { onClick: () => void; icon: ReactNode; children: ReactNode; disabled?: boolean; danger?: boolean }) {
  return <Button size="sm" variant={danger ? 'danger' : 'secondary'} onClick={onClick} disabled={disabled} icon={icon} className="h-9 w-full justify-start !rounded-[10px] px-3">{children}</Button>
}

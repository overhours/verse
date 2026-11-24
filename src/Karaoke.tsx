import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Mic, MicOff, Minimize2, Pause, Play, X } from 'lucide-react'
import { parseLrc } from '../electron/parse'
import { lineText } from '../electron/timed'
import { fmtTime, Song } from './api'
import { Artwork, Backdrop, Button, IconButton } from './ui'
import { themeFor, usePalette } from './palette'

interface KLine { start: number; end: number; text: string; words?: { text: string; start: number; end: number }[] }

export function karaokeLines(song: Song): KLine[] {
  if (song.ai) return song.ai.lines.filter((l) => l.kind === 'vocal' && l.words.length).map((l) => ({ start: l.start, end: l.end, text: lineText(l), words: l.words }))
  if (song.syncedLyrics) {
    const ls = parseLrc(song.syncedLyrics).filter((l) => l.text)
    return ls.map((l, i) => ({ start: l.time, end: Math.min(ls[i + 1]?.time ?? l.time + 5, l.time + 8), text: l.text }))
  }
  return []
}

export default function Karaoke({ song, onClose }: { song: Song; onClose: () => void }) {
  const lines = useMemo(() => karaokeLines(song), [song])
  const inst = song.ai?.instrumentalUrl
  const [singAlong, setSingAlong] = useState(false)
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(song.durationSec ?? 0)
  const [playing, setPlaying] = useState(false)
  const [full, setFull] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const theme = themeFor(usePalette(song.artwork))

  // rAF for a smooth word fill; timeupdate keeps it moving if the window is in the background.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => { if (audio.current) setT(audio.current.currentTime); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const toggle = useCallback(() => { const a = audio.current; if (!a) return; if (a.paused) a.play().catch((e) => setErr(e.message)); else a.pause() }, [])
  const seek = (x: number) => { if (audio.current) { audio.current.currentTime = Math.max(0, Math.min(x, dur)); setT(audio.current.currentTime) } }
  const switchTrack = (v: boolean) => {
    const a = audio.current
    const at = a?.currentTime ?? 0, was = a ? !a.paused : false
    setSingAlong(v)
    a?.addEventListener('loadedmetadata', () => { a.currentTime = at; if (was) a.play().catch(() => {}) }, { once: true })
  }
  const toggleFull = () => { if (document.fullscreenElement) document.exitFullscreen(); else root.current?.requestFullscreen().catch(() => {}) }

  useEffect(() => {
    const onFs = () => setFull(!!document.fullscreenElement)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ') { e.preventDefault(); toggle() }
      else if (e.key === 'Escape' && !document.fullscreenElement) onClose()
      else if (e.key === 'ArrowLeft') seek((audio.current?.currentTime ?? 0) - 5)
      else if (e.key === 'ArrowRight') seek((audio.current?.currentTime ?? 0) + 5)
      else if (e.key.toLowerCase() === 'f') toggleFull()
    }
    document.addEventListener('fullscreenchange', onFs)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('fullscreenchange', onFs); window.removeEventListener('keydown', onKey); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}) }
  })

  let idx = -1
  for (let lo = 0, hi = lines.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (lines[m].start <= t + 0.05) { idx = m; lo = m + 1 } else hi = m - 1 }
  const cur = lines[idx], next = lines[idx + 1]
  const inGap = !cur || t > cur.end + 0.6
  const untilNext = next ? next.start - t : Infinity

  const fill = (s: number, e: number) => Math.max(0, Math.min(1, (t - s) / Math.max(0.05, e - s))) * 100
  const sung = (l: KLine) => (l.words
    ? l.words.map((w, i) => {
      const p = fill(w.start, w.end)
      return (
        <span key={i} className="inline-block whitespace-pre bg-clip-text text-transparent"
          style={{ backgroundImage: `linear-gradient(90deg, color-mix(in oklab, #ffffff 50%, var(--accent)) ${p}%, rgb(255 255 255 / 0.32) ${p}%)` }}>
          {w.text}{i < l.words!.length - 1 ? ' ' : ''}
        </span>
      )
    })
    : <span className="text-fg">{l.text}</span>)

  // Portal to <body>: an animated ancestor would otherwise trap this full-screen layer inside its box.
  return createPortal(
    <div ref={root} className="fade fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg" role="dialog" aria-modal="true" aria-label={`Karaoke: ${song.title}`}>
      <Backdrop full theme={theme} src={song.artwork} />
      {/* The window can still be moved from the top edge; Windows draws its own buttons at the right of it. */}
      <div className="drag absolute inset-x-0 top-0 z-10 h-11" aria-hidden />
      <header className="relative z-10 flex items-center gap-4 px-8 pt-14 pb-2 lg:px-14">
        <div className="min-w-0 flex-1">
          <div className="t-eyebrow text-white/50">Karaoke</div>
          <div className="mt-1 truncate text-[15px] font-semibold lg:hidden">{song.title}{song.artist && <span className="font-normal text-white/55"> · {song.artist}</span>}</div>
        </div>
        <Button variant="secondary" size="lg" icon={<X size={16} />} tip="Esc" tipPos="left" onClick={onClose}>Exit</Button>
      </header>

      <main className="relative z-10 grid min-h-0 flex-1 items-center gap-14 px-8 lg:grid-cols-[minmax(220px,340px)_minmax(0,1fr)] lg:px-14 xl:gap-20 xl:px-20">
        <aside className="hidden lg:block">
          <Artwork src={song.artwork} size={340} className="w-full"
            style={{ width: '100%', height: 'auto', aspectRatio: '1', boxShadow: `0 50px 100px -40px ${theme.glow}, 0 30px 60px -30px rgb(0 0 0 / 0.95)` }} />
          <div className="mt-7 line-clamp-2 text-[26px] leading-[1.12] font-bold tracking-[-0.03em]">{song.title}</div>
          {song.artist && <div className="mt-1.5 truncate text-[17px] font-medium" style={{ color: theme.accent }}>{song.artist}</div>}
        </aside>
        <section className="flex min-w-0 flex-col items-center gap-6 text-center lg:items-start lg:text-left" aria-live="off">
          <p key={`p${idx}`} className="line-in min-h-8 max-w-5xl text-[22px] font-semibold tracking-[-0.02em] text-white/30">{idx > 0 && !inGap ? lines[idx - 1].text : ''}</p>
          {inGap ? (
            <div className="flex min-h-28 flex-col items-center justify-center gap-5 lg:items-start">
              <span className="breathe text-5xl text-white/35">♪</span>
              {untilNext < 3.5 && (
                <div className="flex gap-3" aria-label="Get ready">
                  {[3, 2, 1].map((n) => <span key={n} className={`size-2.5 rounded-full transition duration-300 ${untilNext <= n ? 'bg-white/15' : 'bg-accent'}`} />)}
                </div>
              )}
            </div>
          ) : (
            <p key={`c${idx}`} className="line-in min-h-28 max-w-6xl text-[40px] leading-[1.12] font-bold tracking-[-0.035em] md:text-[48px] xl:text-[58px]">{cur && sung(cur)}</p>
          )}
          <p key={`n${idx}`} className="line-in max-w-5xl text-[24px] font-semibold tracking-[-0.02em] text-white/55">{next?.text}</p>
          <p className="max-w-5xl text-[19px] font-medium tracking-[-0.01em] text-white/28">{lines[idx + 2]?.text}</p>
          {!lines.length && <p className="text-muted">This song has no timed lyrics yet.</p>}
        </section>
      </main>

      <footer className="glass relative z-10 mx-auto mb-8 flex w-[calc(100%-3rem)] max-w-3xl items-center gap-4 rounded-[26px] py-3 pr-4 pl-3">
        <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className="btn-play size-14">
          {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} className="ml-0.5" fill="currentColor" />}
        </button>
        <span className="tabular w-11 text-right text-[12px] font-medium text-white/65">{fmtTime(t)}</span>
        <input type="range" min={0} max={dur || 1} step={0.1} value={t} onChange={(e) => seek(+e.target.value)} aria-label="Position"
          className="seek flex-1" style={{ '--p': `${dur ? (t / dur) * 100 : 0}%` } as CSSProperties} />
        <span className="tabular w-11 text-[12px] font-medium text-white/40">{fmtTime(dur)}</span>
        {inst && (
          <Button onClick={() => switchTrack(!singAlong)} aria-pressed={singAlong} variant={singAlong ? 'primary' : 'secondary'}
            tipPos="up" tip={singAlong ? 'Playing the instrumental, you sing' : 'Mute the original vocals'} icon={singAlong ? <MicOff size={15} /> : <Mic size={15} />}>
            {singAlong ? 'Vocals off' : 'Sing along'}
          </Button>
        )}
        <IconButton label={full ? 'Exit full screen (F)' : 'Full screen (F)'} tipPos="up left" onClick={toggleFull}>
          {full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </IconButton>
      </footer>
      {err && <p className="relative z-10 pb-4 text-center text-[13px] text-bad">{err}</p>}
      <audio ref={audio} src={singAlong && inst ? inst : song.audioUrl} preload="auto" autoPlay
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onError={() => setErr(singAlong ? 'the instrumental track ran away 🏃 re-analyse the song to bring it back' : "the audio file got moved or deleted. it's gone bro 💀")} />
    </div>,
    document.body,
  )
}

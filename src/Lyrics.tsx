import { CSSProperties, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Music, Pause, Play, RotateCcw } from 'lucide-react'
import { appName, lineAt, lrcToPlain, matchPlaying, parseLrc } from '../electron/parse'
import { api, fmtTime, Song } from './api'
import { Button, cx, IconButton, IconTile, Segmented } from './ui'
import StreamPlayer, { StreamControl, streamFor, StreamProblem, StreamState } from './StreamPlayer'
import { sessionTime, useNowPlaying } from './nowPlaying'
import { getPrefs } from './prefs'

// Synced lyrics follow the audio: the file itself for local songs, or the service's official player for Spotify and
// SoundCloud links. When that player only offers a short preview, "play along" runs a timer you start together with
// the song playing elsewhere, with nudge buttons to line it up.
export default function Lyrics({ song }: { song: Song }) {
  const lines = useMemo(() => (song.syncedLyrics ? parseLrc(song.syncedLyrics) : []), [song.syncedLyrics])
  const plain = song.plainLyrics || (song.syncedLyrics ? lrcToPlain(song.syncedLyrics) : '')
  const [mode, setMode] = useState<'synced' | 'plain'>(lines.length ? getPrefs().lyricView : 'plain')
  const [audioErr, setAudioErr] = useState(false)
  const hasAudio = !!song.audioUrl && !audioErr
  const audio = useRef<HTMLAudioElement>(null)
  const clock = useRef<{ start: number; offset: number } | null>(null)
  const [t, setTState] = useState(0)
  const tRef = useRef(0)
  const setT = (x: number) => { tRef.current = x; setTState(x) }
  const [playing, setPlaying] = useState(false)
  const [dur, setDur] = useState(song.durationSec ?? 0)
  const rows = useRef<(HTMLButtonElement | null)[]>([])
  const list = useRef<HTMLDivElement>(null)
  const idx = lineAt(lines, t + 0.15)
  // Keyed on the link only: editing lyrics must not reconnect the player.
  const stream = useMemo(() => (song.audioUrl ? null : streamFor(song)), [song.source, song.sourceUrl, song.audioUrl]) // eslint-disable-line react-hooks/exhaustive-deps
  const [offset, setOffset] = useState(0) // user fine-tuning, seconds added to the player's or app's position
  const offRef = useRef(0)
  offRef.current = offset
  const live = useRef<StreamState | null>(null)
  const ctl = useRef<StreamControl | null>(null)
  const setCtl = useCallback((c: StreamControl) => { ctl.current = c }, [])
  const [follow, setFollow] = useState(false) // the player has the whole song, so lyrics follow it
  const [preview, setPreview] = useState(false) // only a short clip: lyrics can't follow it
  const [streaming, setStreaming] = useState(false)
  const [blocked, setBlocked] = useState(false) // the player says it's playing but never moves: the service won't stream it here
  const [loadFailed, setLoadFailed] = useState(false) // the player never reported in (offline, blocked, removed)
  const [otherTrack, setOtherTrack] = useState(false) // the player moved on to a different track
  const moved = useRef<{ position: number; at: number } | null>(null)
  const started = useRef<{ position: number; at: number } | null>(null)
  const run = useRef<{ position: number; at: number } | null>(null) // start of the current stretch of uninterrupted playback
  const onStream = useCallback((st: StreamState) => {
    const prev = live.current
    live.current = st
    // Protected (copy-protected) streams fail at once: the player starts, then stops where it began.
    if (!st.paused && (!prev || prev.paused)) started.current = { position: st.position, at: st.at }
    if (st.paused && started.current && st.at - started.current.at < 4000 && Math.abs(st.position - started.current.position) < 0.3
      && (!moved.current || moved.current.at < started.current.at)) { started.current = null; setBlocked(true); setFollow(false) }
    // Real playback = the position moves forward between two reports. A 'play' event alone proves nothing.
    // Measured over a run of reports, not between neighbours: SoundCloud reports every ~25 ms, Spotify about once a second.
    if (st.paused || st.buffering) run.current = null
    else if (!run.current || st.position < run.current.position) run.current = { position: st.position, at: st.at }
    else if (st.position > run.current.position + 0.25) { moved.current = { position: st.position, at: st.at }; run.current = { position: st.position, at: st.at }; setBlocked(false) }
    // Lyrics follow only a player that is genuinely progressing through the whole song.
    const full = st.duration > 0 && (song.durationSec ? Math.abs(st.duration - song.durationSec) < 5 : st.duration > 60)
    setFollow(full && !!moved.current); setPreview(st.duration > 0 && !full); setStreaming(!st.paused && !st.buffering)
    setLoadFailed(false)
    if (full && moved.current) {
      if (clock.current) { clock.current = null; setPlaying(false) }
      // Paused, buffering, or just sought: snap to exactly where the player says it is.
      if (st.paused || st.buffering) setT(Math.max(0, st.position + offRef.current))
    }
  }, [song.durationSec])
  const onProblem = useCallback((p: StreamProblem) => {
    setFollow(false)
    if (p === 'failed') setLoadFailed(true)
    else setOtherTrack(true)
  }, [])
  // Started but silent for 6 seconds: say so, and fall back to play-along timing.
  useEffect(() => {
    if (!streaming) return
    const started = performance.now()
    const t = setInterval(() => {
      const m = moved.current, last = m ? m.at : started
      if (performance.now() - last > 6000 && performance.now() - (live.current?.at ?? 0) > 2500) { setBlocked(true); setFollow(false) }
    }, 1000)
    return () => clearInterval(t)
  }, [streaming])
  // The players report their position every few hundred ms; in between, advance smoothly from the last report.
  useEffect(() => {
    if (!follow || !streaming) return
    let raf = 0
    // Never run more than 1.5 s ahead of the player's last report, so a stalled stream can't drag the lyrics along.
    const tick = () => {
      const st = live.current
      if (st) setT(Math.max(0, Math.round((st.position + (st.paused || st.buffering ? 0 : Math.min(1.5, (performance.now() - st.at) / 1000)) + offRef.current) * 20) / 20))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [follow, streaming])

  // Timed lyrics arriving (e.g. imported) switch to the synced view; losing them falls back to plain.
  useEffect(() => { setMode(lines.length ? getPrefs().lyricView : 'plain') }, [lines.length])

  const now = () => hasAudio ? audio.current?.currentTime ?? 0
    : clock.current ? clock.current.offset + (performance.now() - clock.current.start) / 1000 : tRef.current

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => { setT(Math.round(now() * 20) / 20); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, hasAudio])

  // ---- sync to music playing elsewhere on this PC (Spotify app, a browser, Apple Music…) ----
  // This is the main way link songs sync: Windows reports what each media app is playing and where it is.
  const sessions = useNowPlaying(!hasAudio)
  const desk = useMemo(() => (hasAudio ? undefined : matchPlaying(song, sessions)), [hasAudio, sessions, song.title, song.artist]) // eslint-disable-line react-hooks/exhaustive-deps
  const deskRef = useRef(desk)
  deskRef.current = desk
  const deskPlaying = desk?.status === 'Playing'
  useEffect(() => {
    if (!desk || follow) return // the in-app player, when it is following, wins
    if (clock.current) { clock.current = null; setPlaying(false) } // the real player takes over from the play-along timer
    if (!deskPlaying) { setT(Math.max(0, sessionTime(desk) + offRef.current)); return }
    let raf = 0
    const tick = () => { const d = deskRef.current; if (d) setT(Math.max(0, Math.round((sessionTime(d) + offRef.current) * 20) / 20)); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [!!desk, follow, deskPlaying, desk?.position, desk?.updated, offset]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Scroll only the lyrics list (scrollIntoView would also shift the page header out of view).
    const box = list.current, row = rows.current[idx]
    if (mode === 'synced' && idx >= 0 && box && row) box.scrollTo({ top: row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2, behavior: 'smooth' })
  }, [idx, mode])

  const seek = (x: number) => {
    x = Math.max(0, x)
    if (follow && ctl.current) { ctl.current.seek(Math.max(0, x - offRef.current)); setT(x); return } // the embed seeks to that line
    // Synced to another app: ask it to jump to this line (the app's own time, without the fine-tune offset).
    if (desk) { api.nowPlayingSeek(desk.app, Math.max(0, x - offRef.current)).catch(() => {}); setT(x); return }
    if (hasAudio && audio.current) audio.current.currentTime = x
    else if (follow && ctl.current) ctl.current.seek(x)
    else if (clock.current) clock.current = { start: performance.now(), offset: x }
    setT(x)
  }
  const toggleClock = () => {
    if (playing) { setT(now()); clock.current = null; setPlaying(false) }
    else { clock.current = { start: performance.now(), offset: tRef.current }; setPlaying(true) }
  }

  // The song plays whether or not it has lyrics.
  const player = stream && (
        <div className="enter-2 mb-4 max-w-3xl">
          <StreamPlayer stream={stream} title={song.title} onState={onStream} onProblem={onProblem} control={setCtl} />
          {loadFailed && <p className="mt-2 px-1 text-[12px] leading-relaxed text-warn">The {stream.kind === 'spotify' ? 'Spotify' : 'SoundCloud'} player didn't load (offline or blocked?) so the lyrics can't keep up 😵 use manual timing below, or play the song in any app on this PC.</p>}
          {otherTrack && <p className="mt-2 px-1 text-[12px] leading-relaxed text-subtle">The player moved on to a different track, so the lyrics stopped following it.</p>}
          {blocked && <p className="mt-2 px-1 text-[12px] leading-relaxed text-warn">{stream.kind === 'soundcloud' ? 'SoundCloud isn’t streaming this track inside other apps (the label can limit this). Open it on SoundCloud and use Play along below.' : 'The player isn’t streaming this track. Play it in Spotify and use Play along below.'}</p>}
          {preview && !desk && <p className="mt-2 px-1 text-[12px] leading-relaxed text-subtle">This is Spotify's 30-second preview. Play the song in the Spotify app on this PC and the lyrics sync to it automatically.</p>}
        </div>
  )
  if (song.instrumental && !plain) return <div>{player}<Note>This track is instrumental — no lyrics.</Note></div>
  if (!plain && !lines.length) return <div>{player}<Note>sorry lol ☠️ couldn't find the lyrics for this one. hit “Wrong lyrics?” up top and try a different title or artist</Note></div>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {player}
      <div className="enter-2 mb-6 flex flex-wrap items-center gap-3">
        {lines.length > 0 && <Segmented label="Lyrics view" value={mode} onChange={setMode} items={[['synced', 'Synced'], ['plain', 'Plain']]} />}
        {song.audioUrl && !audioErr && (
          <div className="glass flex min-w-[280px] flex-1 items-center gap-3.5 rounded-full py-1.5 pr-5 pl-1.5">
            <button onClick={() => { const a = audio.current; if (a) { if (a.paused) a.play().catch(() => setAudioErr(true)); else a.pause() } }}
              aria-label={playing ? 'Pause' : 'Play'} className="btn-play size-9">
              {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} className="ml-0.5" fill="currentColor" />}
            </button>
            <span className="tabular w-10 text-right text-[12px] font-medium text-white/65">{fmtTime(t)}</span>
            <input type="range" className="seek flex-1" min={0} max={dur || 1} step={0.1} value={Math.min(t, dur || 1)} aria-label="Position" style={{ '--p': `${dur ? Math.min(100, (t / dur) * 100) : 0}%` } as CSSProperties}
              onChange={(e) => seek(+e.target.value)} />
            <span className="tabular w-10 text-[12px] font-medium text-white/40">{fmtTime(dur)}</span>
          </div>
        )}
        {mode === 'synced' && follow && stream && (
          <>
          <div className="glass flex shrink-0 items-center gap-1 rounded-full py-1 pr-1.5 pl-3.5 text-[12px] text-muted" role="status">
            <span className={cx('size-2 rounded-full', streaming ? 'bg-ok shadow-[0_0_10px_var(--ok)]' : 'bg-white/30')} aria-hidden />
            <span className="mr-1.5 ml-1 font-semibold text-fg">Synced to the {stream.kind === 'spotify' ? 'Spotify' : 'SoundCloud'} player</span>
            <span className="tabular w-10 text-center font-medium text-white/65">{fmtTime(t)}</span>
            <Button size="sm" variant="ghost" className="!rounded-full" onClick={() => setOffset((o) => Math.round((o - 0.5) * 10) / 10)} tip="Lyrics earlier" aria-label="Lyrics half a second earlier">−0.5s</Button>
            <Button size="sm" variant="ghost" className="!rounded-full" onClick={() => setOffset((o) => Math.round((o + 0.5) * 10) / 10)} tip="Lyrics later" aria-label="Lyrics half a second later">+0.5s</Button>
            {offset !== 0 && <Button size="sm" variant="ghost" className="!rounded-full tabular" tip="Reset timing" onClick={() => setOffset(0)}>{offset > 0 ? '+' : ''}{offset}s ✕</Button>}
          </div>
          <span className="text-[12px] text-subtle">{streaming ? 'Click a line to jump the song there.' : 'Paused.'}</span>
          </>
        )}
        {mode === 'synced' && desk && !follow && (
          <>
          <div className="glass flex shrink-0 items-center gap-1 rounded-full py-1 pr-1.5 pl-3.5 text-[12px] text-muted" role="status">
            <span className={cx('size-2 rounded-full', deskPlaying ? 'bg-ok shadow-[0_0_10px_var(--ok)]' : 'bg-white/30')} aria-hidden />
            <span className="mr-1.5 ml-1 font-semibold text-fg">Synced to {appName(desk.app)}</span>
            <span className="tabular w-10 text-center font-medium text-white/65">{fmtTime(t)}</span>
            <Button size="sm" variant="ghost" className="!rounded-full" onClick={() => setOffset((o) => Math.round((o - 0.5) * 10) / 10)} tip="Lyrics earlier" aria-label="Lyrics half a second earlier">−0.5s</Button>
            <Button size="sm" variant="ghost" className="!rounded-full" onClick={() => setOffset((o) => Math.round((o + 0.5) * 10) / 10)} tip="Lyrics later" aria-label="Lyrics half a second later">+0.5s</Button>
            {offset !== 0 && <Button size="sm" variant="ghost" className="!rounded-full tabular" tip="Reset timing" onClick={() => setOffset(0)}>{offset > 0 ? '+' : ''}{offset}s ✕</Button>}
          </div>
          <span className="text-[12px] text-subtle">{deskPlaying ? 'Click a line to jump the song there.' : `Paused in ${appName(desk.app)}.`}</span>
          </>
        )}
        {mode === 'synced' && !hasAudio && !follow && !desk && (
          <>
          <div className="glass flex shrink-0 items-center gap-1 rounded-full py-1 pr-1.5 pl-1 text-[12px] text-muted" role="status" aria-label="Manual timing">
            <span className="pr-1.5 pl-2.5 font-semibold text-white/55">Manual timing</span>
            <Button variant="primary" size="sm" icon={playing ? <Pause size={13} /> : <Play size={13} />} onClick={toggleClock}>{playing ? 'Pause' : t ? 'Resume' : 'Play along'}</Button>
            <span className="tabular w-11 text-center font-medium text-white/65">{fmtTime(t)}</span>
            <Button size="sm" variant="ghost" className="!rounded-full" onClick={() => seek(t - 0.5)} tip="Lyrics earlier" aria-label="Lyrics half a second earlier">−0.5s</Button>
            <Button size="sm" variant="ghost" className="!rounded-full" onClick={() => seek(t + 0.5)} tip="Lyrics later" aria-label="Lyrics half a second later">+0.5s</Button>
            <IconButton label="Restart" size="sm" className="!rounded-full" onClick={() => seek(0)}><RotateCcw size={13} /></IconButton>
          </div>
          {!playing && !t && <span className="text-[12px] text-subtle">{stream?.kind === 'soundcloud' && !blocked ? 'Press play in the player above, or play the song in any app on this PC: the lyrics sync automatically.' : 'Play this song in Spotify or any app on this PC and the lyrics sync automatically.'}</span>}
          </>
        )}
      </div>

      {song.audioUrl && (
        <audio ref={audio} src={song.audioUrl} preload="metadata" onError={() => setAudioErr(true)} onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => { if (!playing) setT(e.currentTarget.currentTime) }} onSeeked={(e) => setT(e.currentTarget.currentTime)} />
      )}
      {audioErr && <p className="mb-4 text-[12px] text-bad">The audio file was moved or deleted, so playback isn't available. Play-along timing still works.</p>}

      {/* Soft fade at the top and bottom edges, so lines drift in and out rather than being cut off. */}
      <div ref={list} className="selectable enter-3 relative -mx-3 min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-[40vh] [mask-image:linear-gradient(180deg,transparent_0,#000_24px,#000_calc(100%-96px),transparent)]">
        {mode === 'plain' ? (
          <pre className="max-w-3xl px-3 pt-3 font-sans text-[19px] leading-[1.85] font-medium whitespace-pre-wrap text-white/85">{plain}</pre>
        ) : lines.map((l, i) => (
          <button key={i} ref={(el) => { rows.current[i] = el }} onClick={() => seek(l.time)}
            className={cx('lyric block w-full max-w-4xl rounded-[14px] px-3 py-2 text-left text-[length:var(--lyric-size,30px)] leading-[1.22] font-bold tracking-[-0.028em] hover:bg-white/[0.04]',
              i === idx ? 'now' : i < idx ? 'text-white/25 hover:text-white/60' : i === idx + 1 ? 'text-fg/80 hover:text-fg' : 'text-white/42 hover:text-white/75')}>
            {l.text || '♪'}
          </button>
        ))}
      </div>
    </div>
  )
}

const Note = ({ children }: { children: ReactNode }) => (
  <div className="card enter-2 flex max-w-xl items-start gap-3.5 p-5">
    <IconTile tone="ocean" size={34}><Music size={16} /></IconTile>
    <p className="pt-1.5 text-[13px] leading-relaxed text-muted">{children}</p>
  </div>
)

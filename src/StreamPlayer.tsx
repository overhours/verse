import { useEffect, useRef } from 'react'
import type { Song } from './api'

// Songs opened from a Spotify or SoundCloud link play through that service's official embedded player.
// We speak each player's documented postMessage protocol directly: the Spotify Embed iFrame API's `playback_update`
// event, and the SoundCloud Widget API's PLAY / PLAY_PROGRESS / PAUSE / SEEK / FINISH events. (Their helper scripts
// send exactly these messages; we don't load them, so third-party code never runs inside the app itself.)

export type Stream = { kind: 'spotify' | 'soundcloud'; src: string; origin: string; height: number; id?: string }
// Seconds. `at` = performance.now() of the report. `buffering`: the player is waiting for data, so time isn't moving.
export type StreamState = { position: number; duration: number; paused: boolean; buffering: boolean; at: number }

export function streamFor(song: Song): Stream | null {
  if (song.source === 'spotify') {
    const id = song.sourceUrl?.match(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})/)?.[1]
    return id ? { kind: 'spotify', id, src: `https://open.spotify.com/embed/track/${id}?theme=0`, origin: 'https://open.spotify.com', height: 80 } : null
  }
  if (song.source === 'soundcloud' && song.sourceUrl && /^https:\/\/(on\.)?soundcloud\.com\//.test(song.sourceUrl)) {
    const q = new URLSearchParams({ url: song.sourceUrl, color: '#ffcf3a', auto_play: 'false', hide_related: 'true', show_comments: 'false', show_reposts: 'false', show_teaser: 'false', visual: 'false' })
    return { kind: 'soundcloud', src: `https://w.soundcloud.com/player/?${q}`, origin: 'https://w.soundcloud.com', height: 166 }
  }
  return null
}

export interface StreamControl { seek: (sec: number) => void }
export type StreamProblem = 'failed' | 'other-track'

const LOAD_TIMEOUT = 15000

export default function StreamPlayer({ stream, title, onState, onProblem, control }: {
  stream: Stream; title: string; onState: (s: StreamState) => void; onProblem?: (p: StreamProblem) => void; control?: (c: StreamControl) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const cb = useRef(onState)
  cb.current = onState
  const problem = useRef(onProblem)
  problem.current = onProblem

  useEffect(() => {
    const send = (msg: unknown) => frame.current?.contentWindow?.postMessage(stream.kind === 'soundcloud' ? JSON.stringify(msg) : msg, stream.origin)
    let duration = 0, paused = true, ready = false, soundId: number | null = null, foreign = false // soundId: the widget's own number for the loaded sound, from its events
    const report = (position: number) => cb.current({ position, duration, paused, buffering: false, at: performance.now() })
    // A player that never says it's ready (offline, blocked, removed) is reported once, so the lyrics stay on manual timing.
    const loadTimer = setTimeout(() => { if (!ready) problem.current?.('failed') }, LOAD_TIMEOUT)
    const markReady = () => { if (!ready) { ready = true; clearTimeout(loadTimer) } }
    const otherTrack = () => { if (!foreign) { foreign = true; problem.current?.('other-track') } }

    const onMessage = (e: MessageEvent) => {
      // Only this player's own frame, from the expected origin.
      if (e.source !== frame.current?.contentWindow || e.origin !== stream.origin) return

      if (stream.kind === 'spotify') {
        const d = e.data as { type?: string; payload?: { isPaused?: boolean; isBuffering?: boolean; position?: number; duration?: number; playingURI?: string } }
        if (d?.type === 'ready') { markReady(); return }
        if (d?.type !== 'playback_update' || !d.payload) return
        markReady()
        // The embed can be switched to another track from inside it; positions from that track mean nothing here.
        if (stream.id && d.payload.playingURI && d.payload.playingURI !== `spotify:track:${stream.id}`) { otherTrack(); return }
        duration = (d.payload.duration ?? 0) / 1000
        cb.current({ position: (d.payload.position ?? 0) / 1000, duration, paused: !!d.payload.isPaused, buffering: !!d.payload.isBuffering, at: performance.now() })
        return
      }

      let d: { method?: string; value?: { currentPosition?: number; soundId?: number } | number | null }
      try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data } catch { return }
      if (d.method === 'ready') {
        markReady()
        for (const ev of ['playProgress', 'play', 'pause', 'finish', 'seek']) send({ method: 'addEventListener', value: ev })
        send({ method: 'getDuration' })
        return
      }
      const v = d.value && typeof d.value === 'object' ? d.value : null
      if (d.method === 'getDuration' && typeof d.value === 'number') { duration = d.value / 1000; return }
      if (!v || typeof v.currentPosition !== 'number') return
      markReady()
      // Events carry the widget's number for the playing sound: one that differs from the song we loaded means the widget moved on (e.g. after FINISH).
      if (typeof v.soundId === 'number') {
        if (soundId === null) soundId = v.soundId
        else if (v.soundId !== soundId) { otherTrack(); return }
      }
      if (!duration) send({ method: 'getDuration' }) // e.g. this listener attached after the player was ready
      // Playing/paused comes only from PLAY, PAUSE and FINISH. PLAY_PROGRESS and SEEK keep the state: the widget sends
      // a stray progress report after pausing, and seeking while paused must stay paused.
      if (d.method === 'play') paused = false
      else if (d.method === 'pause' || d.method === 'finish') paused = true
      report(v.currentPosition / 1000)
    }

    window.addEventListener('message', onMessage)
    if (stream.kind === 'soundcloud') send({ method: 'getDuration' }) // answers only if the player is already ready
    control?.({
      seek: (sec) => stream.kind === 'spotify'
        ? send({ command: 'seek', timestamp: Math.max(0, sec) })
        : send({ method: 'seekTo', value: Math.max(0, sec) * 1000 }),
    })
    return () => { window.removeEventListener('message', onMessage); clearTimeout(loadTimer) }
  }, [stream, control])

  return (
    <div className="glass overflow-hidden rounded-[16px] p-1" style={{ height: stream.height + 8 }}>
      <iframe key={stream.src} ref={frame} src={stream.src} title={`${stream.kind === 'spotify' ? 'Spotify' : 'SoundCloud'} player: ${title}`}
        allow="autoplay; encrypted-media" className="block size-full rounded-[12px] border-0" style={{ height: stream.height }} />
    </div>
  )
}

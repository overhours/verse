import { KeyboardEvent, MouseEvent, RefObject, useEffect, useRef } from 'react'

interface Props {
  peaks: number[] | null
  durationSec: number
  audio?: RefObject<HTMLAudioElement | null>
  regions?: { start: number; end: number; active?: boolean; uncertain?: boolean }[]
  onSeek?: (t: number) => void
  height?: number
  scanning?: boolean
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// Canvas waveform. The playhead is drawn every frame from the audio element directly so React never re-renders for it.
export default function Waveform({ peaks, durationSec, audio, regions = [], onSeek, height = 72, scanning }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const props = useRef({ peaks, durationSec, regions, scanning })
  props.current = { peaks, durationSec, regions, scanning }

  useEffect(() => {
    let raf = 0
    const draw = (now: number) => {
      const c = canvas.current
      if (c) {
        const dpr = window.devicePixelRatio || 1
        const w = c.clientWidth, h = c.clientHeight
        if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr }
        const g = c.getContext('2d')!
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, w, h)
        const { peaks, durationSec: d, regions, scanning } = props.current
        const t = audio?.current?.currentTime ?? 0
        const accent = css('--accent'), muted = css('--subtle'), warn = css('--warn')
        for (const r of regions) {
          if (!d) break
          g.fillStyle = r.uncertain ? warn : accent
          g.globalAlpha = r.active ? 0.16 : 0.05
          g.fillRect((r.start / d) * w, 0, Math.max(1, ((r.end - r.start) / d) * w), h)
        }
        g.globalAlpha = 1
        if (peaks?.length) {
          const bar = w / peaks.length
          const mid = h / 2
          const scale = 1 / Math.max(0.05, ...peaks)
          // Played bars get a glossy lavender gradient; the rest are quiet white.
          const gloss = g.createLinearGradient(0, 0, 0, h)
          gloss.addColorStop(0, css('--accent-deep')); gloss.addColorStop(0.5, css('--accent')); gloss.addColorStop(1, css('--accent-deep'))
          const bw = Math.max(1, bar - (bar > 3 ? 1.2 : 0.6))
          for (let i = 0; i < peaks.length; i++) {
            const x = i * bar
            const played = d && (x / w) * d <= t
            g.fillStyle = played ? gloss : '#ffffff'
            g.globalAlpha = played ? 1 : 0.24
            const a = Math.max(2, peaks[i] * scale * (h - 8))
            g.beginPath(); g.roundRect(x, mid - a / 2, bw, a, Math.min(bw / 2, 2)); g.fill()
          }
          g.globalAlpha = 1
        } else {
          g.fillStyle = muted; g.globalAlpha = 0.3; g.fillRect(0, h / 2 - 0.5, w, 1); g.globalAlpha = 1
        }
        if (scanning) {
          const x = ((now / 2200) % 1) * w
          const grad = g.createLinearGradient(x - 80, 0, x, 0)
          grad.addColorStop(0, 'transparent'); grad.addColorStop(1, accent)
          g.fillStyle = grad; g.globalAlpha = 0.18; g.fillRect(x - 80, 0, 80, h); g.globalAlpha = 1
        }
        if (d && audio?.current) {
          g.save(); g.shadowColor = accent; g.shadowBlur = 10
          g.fillStyle = '#ffffff'
          g.beginPath(); g.roundRect((t / d) * w - 1, 2, 2, h - 4, 1); g.fill()
          g.restore()
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [audio])

  const seek = (e: MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek || !durationSec) return
    const r = e.currentTarget.getBoundingClientRect()
    onSeek(((e.clientX - r.left) / r.width) * durationSec)
  }
  const key = (e: KeyboardEvent) => {
    const a = audio?.current
    if (!onSeek || !a) return
    if (e.key === 'ArrowLeft') { onSeek(Math.max(0, a.currentTime - 5)); e.preventDefault() }
    if (e.key === 'ArrowRight') { onSeek(Math.min(durationSec, a.currentTime + 5)); e.preventDefault() }
  }

  return (
    <canvas ref={canvas} onClick={seek} onKeyDown={key} tabIndex={onSeek ? 0 : -1} role={onSeek ? 'slider' : 'img'}
      aria-label={onSeek ? 'Song position — click or use arrow keys to seek' : 'Waveform'}
      aria-valuemin={0} aria-valuemax={Math.round(durationSec)}
      className={`block w-full rounded-[12px] bg-black/30 shadow-[inset_0_1px_3px_rgb(0_0_0/0.4)] ${onSeek ? 'cursor-pointer' : ''}`} style={{ height }} />
  )
}

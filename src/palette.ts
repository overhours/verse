import { useEffect, useState } from 'react'
import { api, Palette } from './api'

// Artwork palettes are computed once per image (in the main process) and shared by every screen.
const cache = new Map<string, Promise<Palette | null>>()

export function usePalette(src?: string): Palette | null {
  const [p, setP] = useState<Palette | null>(null)
  useEffect(() => {
    if (!src) { setP(null); return }
    let live = true
    let job = cache.get(src)
    if (!job) {
      if (cache.size > 100) cache.clear()
      job = api.artPalette(src).catch(() => null)
      cache.set(src, job)
    }
    job.then((x) => { if (live) setP(x) })
    return () => { live = false }
  }, [src])
  return p
}

type Hsl = [number, number, number]
function toHsl(hex: string): Hsl {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn
  if (!d) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}
const css = ([h, s, l]: Hsl) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// The house aurora, used when there is no artwork.
export const HOUSE = { c1: '#8a3b1c', c2: '#c99a2e', c3: '#2b2620', c4: '#5a2a1e' }

export interface Theme { c1: string; c2: string; c3: string; c4: string; accent: string; glow: string }

// Turns a palette into backdrop colours that are rich but never neon or muddy, and a light tint for text accents.
export function themeFor(p: Palette | null): Theme {
  if (!p || !p.colors.length) return { ...HOUSE, accent: 'var(--accent)', glow: 'rgb(255 207 58 / 0.3)' }
  const hs = p.colors.map(toHsl)
  if (p.muted) {
    // Greyscale artwork: keep its greys, with a breath of the house violet so the page doesn't go flat.
    const g = hs.map(([h, s, l]) => css([h, Math.min(s, 0.12), clamp(l, 0.2, 0.42)]))
    return { c1: g[0], c2: HOUSE.c2, c3: g[1] ?? HOUSE.c3, c4: g[2] ?? HOUSE.c4, accent: 'var(--accent)', glow: 'rgb(0 0 0 / 0.6)' }
  }
  const rich = hs.map(([h, s, l]) => [h, clamp(s, 0.38, 0.82), clamp(l, 0.3, 0.56)] as Hsl)
  // Fewer than four colours: fill in with neighbours of the main hue, so the fields stay in the artwork's family.
  while (rich.length < 4) { const [h, s, l] = rich[rich.length % hs.length]; rich.push([(h + (rich.length % 2 ? 28 : -24) + 360) % 360, s * 0.9, l * 0.85]) }
  const vivid = [...hs].sort((a, b) => b[1] - a[1])[0]
  const [h, s, l] = rich[0]
  return {
    c1: css(rich[0]), c2: css(rich[1]), c3: css(rich[2]), c4: css(rich[3]),
    accent: css([vivid[0], clamp(vivid[1], 0.45, 0.8), 0.8]),
    glow: `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}% / 0.5)`,
  }
}

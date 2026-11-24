// Picks the main colours of a piece of artwork from its raw pixels, for artwork-tinted backgrounds.
// Pure: the caller decodes the image (Electron's nativeImage gives BGRA pixels).

export interface Palette {
  colors: string[] // up to 4 distinct colours, most prominent first, as #rrggbb
  muted: boolean // true for greyscale or nearly colourless artwork
}

const hex = (c: { r: number; g: number; b: number }) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

// Lightness, and chroma (how far from grey): unlike HSL saturation it stays near 0 for near-black and near-white.
function lc(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255
  return { l: (mx + mn) / 2, c: mx - mn }
}

export function paletteFromPixels(px: Uint8Array, order: 'bgra' | 'rgba' = 'bgra', max = 4): Palette {
  // Group similar colours (4 bits per channel), then score each group: colourful mid-tones count most,
  // near-black and near-white backgrounds least, so the palette describes the artwork, not its border.
  const groups = new Map<number, { r: number; g: number; b: number; n: number }>()
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 128) continue
    const r = order === 'bgra' ? px[i + 2] : px[i], g = px[i + 1], b = order === 'bgra' ? px[i] : px[i + 2]
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const e = groups.get(k)
    if (e) { e.r += r; e.g += g; e.b += b; e.n++ } else groups.set(k, { r, g, b, n: 1 })
  }
  const scored = [...groups.values()].map((e) => {
    const c = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n }
    const { l, c: chroma } = lc(c.r, c.g, c.b)
    const tone = l < 0.15 || l > 0.88 ? 0.6 : 1
    return { ...c, l, chroma, score: e.n * (0.3 + 1.6 * chroma) * tone }
  }).sort((a, b) => b.score - a.score)
  // Near-black and near-white are backgrounds and borders: only used when the artwork has nothing else.
  const usable = scored.filter((c) => c.l >= 0.08 && c.l <= 0.94)
  const pool = usable.length ? usable : scored

  const picked: typeof scored = []
  const far = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) > 56
  for (const c of pool) {
    if (picked.every((p) => far(p, c))) picked.push(c)
    if (picked.length === max) break
  }
  return { colors: picked.map(hex), muted: picked.length === 0 || picked.every((c) => c.chroma < 0.12) }
}

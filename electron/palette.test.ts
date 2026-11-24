import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paletteFromPixels } from './palette'

const image = (blocks: [number, number, number, number][]) => {
  // blocks: [r, g, b, pixel count]; returned as BGRA, like Electron's nativeImage
  const px: number[] = []
  for (const [r, g, b, n] of blocks) for (let i = 0; i < n; i++) px.push(b, g, r, 255)
  return new Uint8Array(px)
}

test('paletteFromPixels: picks the artwork colours, most prominent first, ignoring a black border', () => {
  const p = paletteFromPixels(image([[5, 5, 5, 600], [200, 40, 60, 250], [30, 90, 210, 150]]))
  assert.equal(p.muted, false)
  assert.deepEqual(p.colors.slice(0, 2), ['#c8283c', '#1e5ad2'])
})

test('paletteFromPixels: near-identical shades collapse into one colour; RGBA input works too', () => {
  const p = paletteFromPixels(image([[200, 40, 60, 100], [204, 44, 62, 100]]))
  assert.equal(p.colors.length, 1)
  const rgba = new Uint8Array([10, 200, 30, 255, 10, 200, 30, 255])
  assert.deepEqual(paletteFromPixels(rgba, 'rgba').colors, ['#0ac81e'])
})

test('paletteFromPixels: greyscale artwork is reported as muted; transparent pixels are skipped', () => {
  // silver lettering on a mostly near-black cover: muted, and the black background is not the lead colour
  const silver = paletteFromPixels(image([[10, 11, 6, 800], [56, 57, 55, 120], [183, 183, 185, 80]]))
  assert.equal(silver.muted, true)
  assert.notEqual(silver.colors[0], '#0a0b06')
  assert.equal(paletteFromPixels(image([[30, 30, 30, 100], [180, 180, 180, 100]])).muted, true)
  assert.deepEqual(paletteFromPixels(new Uint8Array([255, 0, 0, 0])).colors, [])
})

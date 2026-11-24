import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demix, Dft, SR } from './separate'

test('Bluestein DFT matches a direct DFT, forward and inverse', () => {
  const n = 15
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 1.3) + 0.2 * i), im = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.7))
  const exp = Array.from({ length: n }, (_, k) => {
    let r = 0, m = 0
    for (let j = 0; j < n; j++) { const a = (-2 * Math.PI * j * k) / n; r += re[j] * Math.cos(a) - im[j] * Math.sin(a); m += re[j] * Math.sin(a) + im[j] * Math.cos(a) }
    return [r, m]
  })
  const r2 = Float64Array.from(re), i2 = Float64Array.from(im)
  const d = new Dft(n)
  d.run(r2, i2)
  exp.forEach(([r, m], k) => { assert.ok(Math.abs(r2[k] - r) < 1e-9 && Math.abs(i2[k] - m) < 1e-9, `bin ${k}`) })
  d.run(r2, i2, true)
  re.forEach((v, k) => assert.ok(Math.abs(r2[k] - v) < 1e-9 && Math.abs(i2[k] - im[k]) < 1e-9))
})

test('demix with a pass-through model reconstructs stereo audio (STFT/ISTFT, chunking, channel packing)', async () => {
  const n = Math.round(SR * 7.3) // spans two chunks plus padding
  const L = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR))
  const R = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 3000 * i) / SR + 1))
  let calls = 0
  const [ol, or] = await demix(L, R, async (s) => { calls++; return s }, new AbortController().signal, () => {})
  assert.equal(calls, 2)
  let err = 0
  // The test tones start and stop abruptly; ignore the band-limited ringing at the very edges.
  for (let i = SR * 0.05; i < n - SR * 0.05; i++) err = Math.max(err, Math.abs(ol[i] / 1.009 - L[i]), Math.abs(or[i] / 1.009 - R[i]))
  assert.ok(err < 1e-4, `max error ${err}`)
})

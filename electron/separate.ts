import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Cancelled, ffmpeg } from './audio'

// UVR MDX-Net vocal model (Kim Vocal 2) settings, from UVR's model_data.json entry for this file.
const N_FFT = 7680, HOP = 1024, DIM_F = 3072, DIM_T = 256, COMPENSATE = 1.009
const CHUNK = HOP * (DIM_T - 1)
const TRIM = N_FFT / 2
const GEN = CHUNK - 2 * TRIM
export const SR = 44100

// ---------- FFT ----------

function fft2(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr
      }
    }
  }
}

// Bluestein's algorithm: an exact DFT of any length via power-of-two FFTs.
export class Dft {
  private m: number
  private cr: Float64Array; private ci: Float64Array; private br: Float64Array; private bi: Float64Array
  private ar: Float64Array; private ai: Float64Array
  constructor(private n: number) {
    this.m = 1 << Math.ceil(Math.log2(2 * n - 1))
    this.cr = new Float64Array(n); this.ci = new Float64Array(n)
    for (let k = 0; k < n; k++) { const a = (Math.PI * ((k * k) % (2 * n))) / n; this.cr[k] = Math.cos(a); this.ci[k] = -Math.sin(a) }
    this.br = new Float64Array(this.m); this.bi = new Float64Array(this.m)
    for (let k = 0; k < n; k++) {
      this.br[k] = this.cr[k]; this.bi[k] = -this.ci[k]
      if (k) { this.br[this.m - k] = this.cr[k]; this.bi[this.m - k] = -this.ci[k] }
    }
    fft2(this.br, this.bi, false)
    this.ar = new Float64Array(this.m); this.ai = new Float64Array(this.m)
  }
  // In place. Forward is unnormalised; inverse divides by n (matching numpy/torch).
  run(re: Float64Array, im: Float64Array, inverse = false) {
    const { n, m, cr, ci, ar, ai } = this
    const s = inverse ? -1 : 1 // inverse DFT = conj(DFT(conj(x))) / n
    ar.fill(0); ai.fill(0)
    for (let k = 0; k < n; k++) { const xr = re[k], xi = s * im[k]; ar[k] = xr * cr[k] - xi * ci[k]; ai[k] = xr * ci[k] + xi * cr[k] }
    fft2(ar, ai, false)
    for (let k = 0; k < m; k++) { const r = ar[k] * this.br[k] - ai[k] * this.bi[k]; ai[k] = ar[k] * this.bi[k] + ai[k] * this.br[k]; ar[k] = r }
    fft2(ar, ai, true)
    for (let k = 0; k < n; k++) {
      const xr = ar[k] / m, xi = ai[k] / m
      re[k] = (xr * cr[k] - xi * ci[k]) / (inverse ? n : 1)
      im[k] = s * (xr * ci[k] + xi * cr[k]) / (inverse ? n : 1)
    }
  }
}

const WINDOW = Float64Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT))

// Stereo STFT of one chunk (torch.stft, center=True, reflect padding) into the model's [4, DIM_F, DIM_T] layout:
// channels are L real, L imag, R real, R imag. L and R share one complex transform (z = L + iR).
export function stftChunk(L: Float32Array, R: Float32Array, dft: Dft): Float32Array {
  const pad = N_FFT / 2, len = L.length
  const at = (x: Float32Array, i: number) => x[i < 0 ? -i : i >= len ? 2 * len - 2 - i : i]
  const out = new Float32Array(4 * DIM_F * DIM_T)
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT)
  for (let t = 0; t < DIM_T; t++) {
    for (let n = 0; n < N_FFT; n++) { const i = t * HOP + n - pad; re[n] = at(L, i) * WINDOW[n]; im[n] = at(R, i) * WINDOW[n] }
    dft.run(re, im)
    for (let k = 0; k < DIM_F; k++) {
      const a = re[k], b = im[k], c = re[(N_FFT - k) % N_FFT], d = im[(N_FFT - k) % N_FFT]
      const o = k * DIM_T + t
      out[o] = (a + c) / 2; out[DIM_F * DIM_T + o] = (b - d) / 2
      out[2 * DIM_F * DIM_T + o] = (b + d) / 2; out[3 * DIM_F * DIM_T + o] = (c - a) / 2
    }
  }
  return out
}

// Inverse of stftChunk (torch.istft with overlap-add and window-squared normalisation); bins above DIM_F are zero.
export function istftChunk(spec: Float32Array, dft: Dft): [Float32Array, Float32Array] {
  const S = DIM_F * DIM_T, total = CHUNK + N_FFT
  const yl = new Float64Array(total), yr = new Float64Array(total), ws = new Float64Array(total)
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT)
  for (let t = 0; t < DIM_T; t++) {
    re.fill(0); im.fill(0)
    for (let k = 0; k < DIM_F; k++) {
      const o = k * DIM_T + t
      const lr = spec[o], li = spec[S + o], rr = spec[2 * S + o], ri = spec[3 * S + o]
      re[k] = lr - ri; im[k] = li + rr // Z = XL + i·XR
      if (k) { re[N_FFT - k] = lr + ri; im[N_FFT - k] = rr - li } // conj symmetry: XL[-k]=conj(XL[k]), same for XR
    }
    dft.run(re, im, true)
    for (let n = 0; n < N_FFT; n++) { const i = t * HOP + n; yl[i] += re[n] * WINDOW[n]; yr[i] += im[n] * WINDOW[n]; ws[i] += WINDOW[n] * WINDOW[n] }
  }
  const L = new Float32Array(CHUNK), R = new Float32Array(CHUNK)
  for (let i = 0; i < CHUNK; i++) { const w = ws[i + N_FFT / 2]; L[i] = w > 1e-8 ? yl[i + N_FFT / 2] / w : 0; R[i] = w > 1e-8 ? yr[i + N_FFT / 2] / w : 0 }
  return [L, R]
}

// UVR's MDX demix: pad, run fixed-size chunks, keep each chunk's centre so chunk edges never reach the output.
export async function demix(L: Float32Array, R: Float32Array, model: (spec: Float32Array) => Promise<Float32Array>,
  signal: AbortSignal, onProgress: (f: number) => void): Promise<[Float32Array, Float32Array]> {
  const n = L.length, pad = GEN - (n % GEN), total = n + pad
  const pl = new Float32Array(total + 2 * TRIM), pr = new Float32Array(total + 2 * TRIM)
  pl.set(L, TRIM); pr.set(R, TRIM)
  const ol = new Float32Array(total), or = new Float32Array(total)
  const dft = new Dft(N_FFT)
  for (let i = 0; i < total; i += GEN) {
    if (signal.aborted) throw new Cancelled()
    const spec = await model(stftChunk(pl.subarray(i, i + CHUNK), pr.subarray(i, i + CHUNK), dft))
    const [cl, cr] = istftChunk(spec, dft)
    ol.set(cl.subarray(TRIM, TRIM + GEN), i); or.set(cr.subarray(TRIM, TRIM + GEN), i)
    onProgress(Math.min(1, (i + GEN) / total))
  }
  for (let i = 0; i < n; i++) { ol[i] *= COMPENSATE; or[i] *= COMPENSATE }
  return [ol.subarray(0, n), or.subarray(0, n)]
}

let session: Promise<{ s: import('onnxruntime-node').InferenceSession; gpu: boolean }> | null = null

// DirectML runs the model on any DirectX 12 GPU (AMD, NVIDIA, Intel), roughly 30x faster than the CPU; CPU is the fallback.
async function load(modelFile: string) {
  const ort = await import('onnxruntime-node')
  try { return { s: await ort.InferenceSession.create(modelFile, { executionProviders: ['dml'], graphOptimizationLevel: 'all' }), gpu: true } }
  catch { return { s: await ort.InferenceSession.create(modelFile, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }), gpu: false } }
}

// Isolates vocals into `out` and writes the instrumental (mix minus vocals) to `outInstrumental`, both MP3. Returns whether the GPU was used.
export async function separateLocally(input: string, out: string, outInstrumental: string, modelFile: string, signal: AbortSignal, onProgress: (f: number) => void) {
  const ort = await import('onnxruntime-node')
  session ??= load(modelFile)
  const { s, gpu } = await session
  const raw = await ffmpeg(['-i', input, '-vn', '-ac', '2', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { signal, stdout: true })
  const inter = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
  const L = new Float32Array(inter.length / 2), R = new Float32Array(inter.length / 2)
  for (let i = 0; i < L.length; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1] }
  const [vl, vr] = await demix(L, R, async (spec) => {
    const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', spec, [1, 4, DIM_F, DIM_T]) })
    return r[s.outputNames[0]].data as Float32Array
  }, signal, onProgress)
  const write = async (a: Float32Array, b: Float32Array, file: string) => {
    const pcm = new Float32Array(a.length * 2)
    for (let i = 0; i < a.length; i++) { pcm[2 * i] = a[i]; pcm[2 * i + 1] = b[i] }
    const tmp = path.join(os.tmpdir(), `verse-stem-${process.pid}-${Date.now()}.f32`)
    fs.writeFileSync(tmp, Buffer.from(pcm.buffer))
    try { await ffmpeg(['-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', tmp, '-c:a', 'libmp3lame', '-b:a', '192k', file], { signal }) }
    finally { fs.rmSync(tmp, { force: true }) }
  }
  await write(vl, vr, out)
  await write(L.map((x, i) => x - vl[i]), R.map((x, i) => x - vr[i]), outInstrumental)
  return gpu
}

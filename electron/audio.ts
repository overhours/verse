import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

// ffmpeg-static ships a binary; inside a packaged app it must be read from the unpacked asar copy.
const bundled: string | null = require('ffmpeg-static')
export const FFMPEG = process.env.FFMPEG_PATH || (bundled ? bundled.replace('app.asar', 'app.asar.unpacked') : 'ffmpeg')

export class Cancelled extends Error { constructor() { super('Analysis cancelled.') } }

export function ffmpeg(args: string[], o: { signal?: AbortSignal; onTime?: (sec: number) => void; stdout?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new Cancelled())
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    p.stdout.on('data', (d: Buffer) => { if (o.stdout) out.push(d) })
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      err = (err + s).slice(-8000)
      const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (m && o.onTime) o.onTime(+m[1] * 3600 + +m[2] * 60 + +m[3])
    })
    const abort = () => p.kill('SIGKILL')
    o.signal?.addEventListener('abort', abort, { once: true })
    p.on('error', (e) => reject(new Error(`Could not start ffmpeg (${e.message}).`)))
    p.on('close', (code) => {
      o.signal?.removeEventListener('abort', abort)
      if (o.signal?.aborted) return reject(new Cancelled())
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`ffmpeg couldn't process this audio: ${err.trim().split('\n').slice(-2).join(' ')}`))
    })
  })
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

export async function probe(file: string) {
  const { parseFile } = await import('music-metadata')
  const m = await parseFile(file, { duration: true })
  return { durationSec: m.format.duration ?? 0, sampleRate: m.format.sampleRate, channels: m.format.numberOfChannels, codec: m.format.codec }
}

// Mono 16 kHz FLAC: what speech models want, ~10x smaller than the source.
export const toSpeechFlac = (input: string, out: string, o: { signal?: AbortSignal; onTime?: (s: number) => void; start?: number; end?: number } = {}) =>
  ffmpeg([...(o.start !== undefined ? ['-ss', String(o.start)] : []), '-i', input, ...(o.end !== undefined ? ['-t', String(o.end - (o.start ?? 0))] : []),
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', out], o)

// Full-quality stereo for source separation, re-encoded only if needed to fit the upload limit.
export const toSeparationInput = (input: string, out: string, o: { signal?: AbortSignal; onTime?: (s: number) => void } = {}) =>
  ffmpeg(['-i', input, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '256k', out], o)

export async function silences(file: string, signal?: AbortSignal) {
  const out: { start: number; end: number }[] = []
  let err = ''
  await new Promise<void>((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-i', file, '-af', 'silencedetect=n=-35dB:d=0.5', '-f', 'null', '-'], { windowsHide: true })
    p.stderr.on('data', (d: Buffer) => { err += d.toString() })
    signal?.addEventListener('abort', () => p.kill('SIGKILL'), { once: true })
    p.on('error', reject)
    p.on('close', () => (signal?.aborted ? reject(new Cancelled()) : resolve()))
  })
  let s: number | null = null
  for (const m of err.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    if (m[1] === 'start') s = +m[2]
    else if (s !== null) { out.push({ start: s, end: +m[2] }); s = null }
  }
  return out
}

export const PCM_RATE = 8000
export async function pcm(file: string, signal?: AbortSignal): Promise<Int16Array> {
  const buf = await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', 'pipe:1'], { signal, stdout: true })
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
}

export function peaks(samples: Int16Array, n: number): number[] {
  const out: number[] = []
  const step = samples.length / n
  for (let i = 0; i < n; i++) {
    let m = 0
    for (let j = Math.floor(i * step), e = Math.floor((i + 1) * step); j < e; j++) { const v = Math.abs(samples[j]); if (v > m) m = v }
    out.push(+(m / 32768).toFixed(3))
  }
  return out
}

export function envelope(samples: Int16Array, rate: number, hopSec: number): Float32Array {
  const hop = Math.max(1, Math.round(rate * hopSec))
  const env = new Float32Array(Math.ceil(samples.length / hop))
  for (let i = 0; i < env.length; i++) {
    let s = 0, n = 0
    for (let j = i * hop; j < Math.min(samples.length, (i + 1) * hop); j++) { s += samples[j] * samples[j]; n++ }
    env[i] = Math.sqrt(s / (n || 1)) / 32768
  }
  return env
}

import fs from 'node:fs'
import path from 'node:path'
import { ffmpeg, probe } from './audio'

const syncsafe = (b: Buffer, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]
const toSyncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])
const Z2 = Buffer.from([0, 0])

export interface TimedLine { time: number; text: string }

// Returns the MP3 with an ID3 USLT (lyrics) frame and, for timed lyrics, a SYLT (synchronised lyrics) frame.
// Audio bytes and every other frame (title, artist, album, track, artwork…) are kept byte for byte.
// ffmpeg can't write either frame (it writes a TXXX text field that players ignore), hence this.
export function id3WithLyrics(mp3: Buffer, lyrics: string, synced?: TimedLine[]): Buffer {
  let version = 3, ext: Buffer = Buffer.alloc(0), audio: Buffer = mp3
  const frames: Buffer[] = []
  if (mp3.subarray(0, 3).toString('latin1') === 'ID3') {
    version = mp3[3]
    const flags = mp3[5], size = syncsafe(mp3, 6)
    if (version < 3 || version > 4) throw new Error(`This MP3 has an ID3v2.${version} tag, which can't be updated safely.`)
    if (flags & 0x80) throw new Error("This MP3's tag uses unsynchronisation, which can't be updated safely.")
    const body = mp3.subarray(10, 10 + size)
    audio = mp3.subarray(10 + size + (flags & 0x10 ? 10 : 0))
    let p = 0
    if (flags & 0x40) { const n = version === 4 ? syncsafe(body, 0) : body.readUInt32BE(0) + 4; ext = body.subarray(0, n); p = n }
    while (p + 10 <= body.length && body[p] !== 0) {
      const id = body.subarray(p, p + 4).toString('latin1')
      const len = version === 4 ? syncsafe(body, p + 4) : body.readUInt32BE(p + 4)
      const frame = body.subarray(p, p + 10 + len)
      // Replace old lyrics, including ffmpeg's stray TXXX copies.
      const isOldLyrics = id === 'USLT' || id === 'SYLT' || (id === 'TXXX' && /^(\xff\xfe|\xfe\xff)?(U\0?S\0?L\0?T|l\0?y\0?r\0?i\0?c\0?s)/i.test(frame.subarray(11, 40).toString('latin1')))
      if (!isOldLyrics) frames.push(frame)
      p += 10 + len
    }
  }
  const frame = (id: string, content: Buffer) => {
    const head = Buffer.alloc(10)
    head.write(id, 0, 'latin1')
    if (version === 4) toSyncsafe(content.length).copy(head, 4); else head.writeUInt32BE(content.length, 4)
    return Buffer.concat([head, content])
  }
  // USLT: encoding 1 (UTF-16 with BOM), language, empty descriptor, text.
  frames.push(frame('USLT', Buffer.concat([Buffer.from([1]), Buffer.from('eng', 'latin1'), utf16(''), Z2, utf16(lyrics)])))
  if (synced?.length) {
    // SYLT: encoding 1, language, timestamps in milliseconds (2), content type lyrics (1), empty descriptor, then text + time per line.
    const entries = synced.map((l) => { const t = Buffer.alloc(4); t.writeUInt32BE(Math.max(0, Math.round(l.time * 1000))); return Buffer.concat([utf16(l.text), Z2, t]) })
    frames.push(frame('SYLT', Buffer.concat([Buffer.from([1]), Buffer.from('eng', 'latin1'), Buffer.from([2, 1]), utf16(''), Z2, ...entries])))
  }
  const body = Buffer.concat([ext, ...frames, Buffer.alloc(1024)]) // padding lets later edits avoid rewriting the file
  const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([version, 0, ext.length ? 0x40 : 0]), toSyncsafe(body.length)])
  return Buffer.concat([header, body, audio])
}

export const EMBEDDABLE = ['.mp3', '.flac', '.m4a', '.ogg', '.opus']

// Writes a copy of `src` at `out` with the lyrics embedded; the original is never modified.
// `tag` is what goes in the lyrics tag (LRC text when timed, which is what players that show synced lyrics read);
// `synced` additionally produces an MP3 SYLT frame.
export async function embedLyricsCopy(src: string, out: string, tag: string, synced?: TimedLine[]) {
  const ext = path.extname(src).toLowerCase()
  if (!EMBEDDABLE.includes(ext)) throw new Error(`${ext.slice(1).toUpperCase()} files can't hold lyrics metadata.`)
  if (path.resolve(out).toLowerCase() === path.resolve(src).toLowerCase()) throw new Error('Choose a different file name. The original is never overwritten.')
  if (path.extname(out).toLowerCase() !== ext) throw new Error(`The copy must keep the ${ext} extension.`)
  const tmp = path.join(path.dirname(out), `.verse-${process.pid}-${Date.now()}${ext}`)
  try {
    if (ext === '.mp3') fs.writeFileSync(tmp, id3WithLyrics(fs.readFileSync(src), tag, synced))
    else await ffmpeg(['-i', src, '-map', '0', '-c', 'copy', '-map_metadata', '0', '-metadata', `lyrics=${tag}`, tmp])
    // Keep the copy only if it still decodes to the same length as the original.
    const [a, b] = await Promise.all([probe(src), probe(tmp)])
    if (Math.abs(a.durationSec - b.durationSec) > 0.5) throw new Error('The exported copy did not match the original audio, so it was discarded.')
    fs.renameSync(tmp, out)
  } finally { fs.rmSync(tmp, { force: true }) }
  return { synced: ext === '.mp3' ? !!synced?.length : /^\s*\[\d+:\d/m.test(tag) }
}

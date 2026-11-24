import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ffmpeg } from './audio'
import { embedLyricsCopy, id3WithLyrics } from './tags'

const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const LRC = '[00:00.50]First line ✓\n[00:01.20]Second line'
const SYNCED = [{ time: 0.5, text: 'First line ✓' }, { time: 1.2, text: 'Second line' }]

async function makeSource(dir: string, ext: string) {
  const cover = path.join(dir, 'cover.png')
  if (!fs.existsSync(cover)) await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', cover])
  const file = path.join(dir, `song.${ext}`)
  const codec = { mp3: ['-c:a', 'libmp3lame', '-id3v2_version', '3'], flac: ['-c:a', 'flac'], m4a: ['-c:a', 'aac'] }[ext]!
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=440:d=2', '-i', cover, '-map', '0', '-map', '1', ...codec, '-c:v', ext === 'flac' ? 'png' : 'mjpeg',
    '-disposition:v', 'attached_pic', '-metadata', 'title=My Title', '-metadata', 'artist=Me', '-metadata', 'album=The Album', '-metadata', 'track=3', file])
  return file
}

for (const ext of ['mp3', 'flac', 'm4a']) {
  test(`${ext}: Embed & Export writes a copy with lyrics; metadata, artwork and the original are untouched`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verse-tags-'))
    const src = await makeSource(dir, ext)
    const before = sha(src)
    const out = path.join(dir, `song (lyrics).${ext}`)
    const r = await embedLyricsCopy(src, out, LRC, SYNCED)
    assert.equal(r.synced, true)
    assert.equal(sha(src), before, 'original unchanged')
    const { parseFile } = await import('music-metadata')
    const [a, b] = await Promise.all([parseFile(src, { duration: true }), parseFile(out, { duration: true })])
    for (const k of ['title', 'artist', 'album'] as const) assert.equal(b.common[k], a.common[k], k)
    assert.equal(b.common.track.no, 3)
    assert.equal(b.common.picture?.length, 1, 'artwork kept')
    assert.ok(Math.abs((b.format.duration ?? 0) - (a.format.duration ?? 0)) < 0.05)
    assert.match(JSON.stringify(b.common.lyrics), /First line ✓/)
    if (ext === 'mp3') {
      const native = Object.values(b.native).flat()
      assert.equal(native.filter((t) => t.id === 'USLT').length, 1)
      const sylt = native.find((t) => t.id === 'SYLT')?.value as { syncText?: { text: string; timestamp: number }[] }
      assert.deepEqual(sylt?.syncText?.map((s) => [s.text, s.timestamp]), [['First line ✓', 500], ['Second line', 1200]])
    }
    // Re-exporting replaces lyrics instead of stacking them.
    const out2 = path.join(dir, `again.${ext}`)
    await embedLyricsCopy(out, out2, '[00:00.10]Replaced', [{ time: 0.1, text: 'Replaced' }])
    const c = await parseFile(out2)
    assert.doesNotMatch(JSON.stringify(c.common.lyrics), /First line/)
    await assert.rejects(embedLyricsCopy(src, src, LRC), /never overwritten/)
    assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('.verse-')), 'no temp files left')
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

test('id3WithLyrics adds a tag to an untagged MP3 without touching the audio bytes', () => {
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3])
  const out = id3WithLyrics(audio, 'hi', [{ time: 1, text: 'hi' }])
  assert.equal(out.subarray(0, 3).toString('latin1'), 'ID3')
  assert.deepEqual(out.subarray(out.length - audio.length), audio)
})

test('formats without a lyrics tag are refused clearly', async () => {
  await assert.rejects(embedLyricsCopy('x.wav', 'y.wav', 'a'), /WAV files can't hold lyrics/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { watchNowPlaying } from './nowplaying'

// Regression: waiting for seek commands once blocked the reader, so it never reported anything until a command came.
test('now-playing reader keeps reporting with no commands sent', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  let reports = 0
  const stop = watchNowPlaying(() => { reports++ })
  await new Promise((r) => setTimeout(r, 6000))
  stop()
  assert.ok(reports >= 3, `expected steady reports, got ${reports}`)
})

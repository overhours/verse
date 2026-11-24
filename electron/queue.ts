import { BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Cancelled } from './audio'
import * as lib from './library'
import { lrcToPlain, Song } from './parse'
import { analyze } from './pipeline'
import { AUDIO_EXT, findLyrics, resolveFile } from './sources'
import type { AnalyzeOptions } from './timed'

export interface QueueStatus { running: boolean; phase: 'import' | 'analyse' | 'idle'; done: number; total: number; current?: string; message?: string; errors: number; summary?: string }

let status: QueueStatus = { running: false, phase: 'idle', done: 0, total: 0, errors: 0 }
let ac: AbortController | null = null
let win: BrowserWindow
let lastSend = 0

export const queueStatus = () => status
export const cancelQueue = () => ac?.abort()

function send(force = false) {
  if (!force && Date.now() - lastSend < 250) return
  lastSend = Date.now()
  if (!win.isDestroyed()) win.webContents.send('queue', status)
}
export const libraryChanged = (w: BrowserWindow) => { if (!w.isDestroyed()) w.webContents.send('library:changed') }

export function notify(w: BrowserWindow, body: string) {
  // Only interrupt when the user is elsewhere; the sidebar already shows it otherwise.
  if (!w.isFocused() && Notification.isSupported()) new Notification({ title: 'Verse', body }).show()
}

export function scanFolder(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => AUDIO_EXT.includes(path.extname(f).slice(1).toLowerCase()) && !path.basename(f).startsWith('.verse-'))
    .map((f) => path.join(dir, f))
}

const missingLyrics = (s: Song) => !!s.filePath && !s.plainLyrics && !s.syncedLyrics && !s.instrumental && !s.ai

async function guard(w: BrowserWindow, phase: QueueStatus['phase'], total: number, job: (signal: AbortSignal) => Promise<string>) {
  if (status.running) throw new Error("one thing at a time 😮‍💨 something's already running. wait or cancel it first.")
  win = w
  ac = new AbortController()
  status = { running: true, phase, done: 0, total, errors: 0 }
  send(true)
  // The job replaces `status` as it moves between phases, so assign the summary only after it returns.
  let summary: string
  try { summary = await job(ac.signal) }
  catch (e) { summary = e instanceof Cancelled ? 'Cancelled.' : (e as Error).message }
  finally {
    status = { ...status, running: false, phase: 'idle', current: undefined, message: undefined, summary: summary! }
    ac = null
    send(true)
    libraryChanged(w)
    notify(w, status.summary ?? 'Finished.')
  }
}

export function importFolder(w: BrowserWindow, dir: string, o: { lyrics: boolean; analyse: AnalyzeOptions | null }, cacheRoot: string) {
  const known = new Set(lib.listSongs().map((s) => s.filePath).filter(Boolean))
  const files = scanFolder(dir).filter((f) => !known.has(f))
  if (!files.length) return 0
  void guard(w, 'import', files.length, async (signal) => {
    const added: string[] = []
    for (const f of files) {
      if (signal.aborted) throw new Cancelled()
      status.current = path.basename(f)
      send()
      try {
        const track = await resolveFile(f)
        let lyrics: Partial<Song> = {}
        if (o.lyrics && track.title) {
          try {
            const { best } = await findLyrics(track)
            // Only trust a match of about the same length; a different edit would mean different timings.
            if (best && (!best.durationSec || !track.durationSec || Math.abs(best.durationSec - track.durationSec) <= 10))
              lyrics = { lyricsId: best.id, plainLyrics: best.plainLyrics, syncedLyrics: best.syncedLyrics, instrumental: best.instrumental }
          } catch { /* offline or no match: the song is still imported */ }
        }
        const id = randomUUID()
        lib.saveSong({ ...track, ...lyrics, id, favorite: false, savedAt: Date.now() })
        added.push(id)
      } catch { status.errors++ }
      status.done++
      if (status.done % 5 === 0) libraryChanged(w)
      send()
    }
    libraryChanged(w) // show every imported song before analysis starts
    const msg = `Imported ${added.length} song${added.length === 1 ? '' : 's'}${status.errors ? ` (${status.errors} couldn't be read)` : ''}.`
    if (!o.analyse) return msg
    const todo = lib.listSongs().filter((s) => added.includes(s.id) && missingLyrics(s)).map((s) => s.id)
    if (!todo.length) return msg
    status = { ...status, phase: 'analyse', done: 0, total: todo.length, errors: 0 }
    return `${msg} ${await runAnalyses(todo, o.analyse, cacheRoot, signal)}`
  })
  return files.length
}

export function analyseMissing(w: BrowserWindow, opts: AnalyzeOptions, cacheRoot: string) {
  const todo = lib.listSongs().filter(missingLyrics).map((s) => s.id)
  if (!todo.length) return 0
  void guard(w, 'analyse', todo.length, (signal) => runAnalyses(todo, opts, cacheRoot, signal))
  return todo.length
}

async function runAnalyses(ids: string[], opts: AnalyzeOptions, cacheRoot: string, signal: AbortSignal) {
  let ok = 0
  for (const id of ids) {
    if (signal.aborted) throw new Cancelled()
    const s = lib.listSongs().find((x) => x.id === id)
    if (s?.filePath) {
      status.current = s.title
      send()
      try {
        const ai = await analyze(s.filePath, {
          ...opts, title: s.title, artist: s.artist, reference: s.plainLyrics || (s.syncedLyrics ? lrcToPlain(s.syncedLyrics) : undefined),
        }, cacheRoot, (e) => { status.message = e.message; send() }, signal)
        lib.updateSong(id, { ai })
        libraryChanged(win)
        ok++
      } catch (e) {
        if (e instanceof Cancelled) throw e
        status.errors++
      }
    }
    status.done++
    send()
  }
  return `Analysed ${ok} song${ok === 1 ? '' : 's'}${status.errors ? `; ${status.errors} failed` : ''}.`
}

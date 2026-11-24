import { app, BrowserWindow, dialog, ipcMain, nativeImage, screen, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Cancelled, pcm, peaks } from './audio'
import { getKey, KEYS, KeyName, keyStatus, setKey } from './keys'
import { initLocal, installLocal } from './local'
import * as lib from './library'
import { lrcToPlain, parseLrc, parseLyricsFile, Song, toLrcText } from './parse'
import { analyze, AnalyzeOptions, providerStatus } from './pipeline'
import { AUDIO_EXT, findLyrics, resolveFile, resolveLink } from './sources'
import { analyseMissing, cancelQueue, importFolder, libraryChanged, notify, queueStatus } from './queue'
import { geniusLyrics, searchGenius } from './genius'
import { Palette, paletteFromPixels } from './palette'
import { controlNowPlaying, seekNowPlaying, stopNowPlaying, watchNowPlaying } from './nowplaying'
import { embedLyricsCopy, TimedLine } from './tags'
import { startUpdates } from './updater'
import { lineText, toEnhancedLrc, toJson, toLrc, toSrt, toTxt } from './timed'

type ExportFormat = 'txt' | 'lrc' | 'ai-lrc' | 'elrc' | 'srt' | 'json' | 'ai-txt'
const EXT: Record<ExportFormat, string> = { txt: 'txt', lrc: 'lrc', 'ai-lrc': 'lrc', elrc: 'lrc', srt: 'srt', json: 'json', 'ai-txt': 'txt' }

function exportBody(s: Song, format: ExportFormat) {
  const meta = { title: s.title, artist: s.artist, album: s.album }
  if (format === 'txt') return s.plainLyrics || (s.syncedLyrics && lrcToPlain(s.syncedLyrics))
  if (format === 'lrc') return s.syncedLyrics
  if (!s.ai) return undefined
  return { 'ai-lrc': toLrc, elrc: toEnhancedLrc, srt: toSrt, json: toJson, 'ai-txt': toTxt }[format](s.ai, meta)
}

// Artwork colours for tinted backgrounds. Decoded here (no CORS limits); only https images and embedded data URLs.
const palettes = new Map<string, Palette | null>()
async function artPalette(src: string): Promise<Palette | null> {
  if (palettes.has(src)) return palettes.get(src)!
  let buf: Buffer | null = null
  if (/^data:image\/[\w+.-]+;base64,/i.test(src)) buf = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
  else if (/^https:\/\//i.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(8000) })
    if (r.ok) { const ab = await r.arrayBuffer(); if (ab.byteLength <= 12_000_000) buf = Buffer.from(ab) }
  }
  let out: Palette | null = null
  if (buf) {
    const img = nativeImage.createFromBuffer(buf)
    if (!img.isEmpty()) out = paletteFromPixels(img.resize({ width: 48, height: 48, quality: 'good' }).toBitmap(), 'bgra')
  }
  if (palettes.size > 300) palettes.clear()
  palettes.set(src, out)
  return out
}

const jobs = new Map<string, AbortController>()
const waveCache = new Map<string, number[]>()

let win: BrowserWindow
const cacheRoot = () => path.join(app.getPath('userData'), 'ai-cache')
const boundsFile = () => path.join(app.getPath('userData'), 'window.json')

function createWindow() {
  let saved: { x?: number; y?: number; width?: number; height?: number; maximized?: boolean } = {}
  try { saved = JSON.parse(readFileSync(boundsFile(), 'utf8')) } catch { /* first run */ }
  // Ignore a saved position that is no longer on any screen (e.g. an unplugged monitor).
  const visible = saved.x !== undefined && screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return saved.x! < a.x + a.width - 100 && saved.x! + (saved.width ?? 0) > a.x + 100 && saved.y! >= a.y - 10 && saved.y! < a.y + a.height - 100
  })
  win = new BrowserWindow({
    width: saved.width ?? 1280, height: saved.height ?? 820, minWidth: 720, minHeight: 540,
    ...(visible ? { x: saved.x, y: saved.y } : {}),
    backgroundColor: '#050507',
    icon: path.join(app.getAppPath(), 'build/icon.png'), // dev runs as electron.exe, so set the Verse icon explicitly
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#c9c9d3', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault()) // dropped files must not replace the app
  if (saved.maximized) win.maximize()
  win.on('close', () => {
    try { writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })) } catch { /* not critical */ }
  })
  win.loadFile(path.join(__dirname, '../dist/index.html'))
}

function cleanOpts(o: AnalyzeOptions): AnalyzeOptions {
  return {
    transcriber: o?.transcriber === 'openai' || o?.transcriber === 'local' ? o.transcriber : 'whisperx',
    separate: !!o?.separate, refine: !!o?.refine, diarize: !!o?.diarize,
    language: typeof o?.language === 'string' && /^[a-z]{2,3}$/.test(o.language) ? o.language : '',
    useReference: !!o?.useReference,
    title: typeof o?.title === 'string' ? o.title.slice(0, 200) : undefined,
    artist: typeof o?.artist === 'string' ? o.artist.slice(0, 200) : undefined,
    reference: typeof o?.reference === 'string' ? o.reference.slice(0, 30000) : undefined,
    align: typeof o?.align === 'string' && o.align.trim() ? o.align.slice(0, 50000) : undefined,
    model: o?.model === 'large' ? 'large' : 'turbo',
  }
}

const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R> | R) =>
  async (_e: unknown, ...a: A) => {
    try { return { ok: true, data: await fn(...a) } }
    catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) } }
  }

const str = (v: unknown) => { if (typeof v !== 'string') throw new Error('Invalid input.'); return v }

// A fixed Windows app id (the installer uses the same one), so Verse can recognise its own media sessions.
const APP_ID = 'local.verse.app'
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

app.whenReady().then(() => {
  lib.openLibrary(app.getPath('userData'))
  initLocal(app.getPath('userData'))

  ipcMain.handle('track:link', wrap((s: unknown) => resolveLink(str(s))))
  ipcMain.handle('track:file', wrap((p: unknown) => resolveFile(str(p))))
  ipcMain.handle('track:pick', wrap(async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: AUDIO_EXT }] })
    return r.canceled ? null : resolveFile(r.filePaths[0])
  }))
  ipcMain.handle('lyrics:find', wrap((q: { title: unknown; artist: unknown; durationSec?: unknown }) =>
    findLyrics({ title: str(q.title), artist: str(q.artist ?? ''), durationSec: typeof q.durationSec === 'number' ? q.durationSec : undefined })))
  ipcMain.handle('library:list', wrap(() => lib.listSongs()))
  ipcMain.handle('library:save', wrap((s: Song) => lib.saveSong(s)))
  ipcMain.handle('library:update', wrap((id: unknown, patch: Partial<Song>) => lib.updateSong(str(id), patch)))
  ipcMain.handle('library:delete', wrap((id: unknown) => lib.deleteSong(str(id))))
  ipcMain.handle('lyrics:export', wrap(async (s: Song, format: ExportFormat) => {
    if (!(format in EXT)) throw new Error('Unknown export format.')
    const body = exportBody(s, format)
    if (!body) throw new Error('nothing to export, there are no lyrics lol')
    const ext = EXT[format]
    const suffix = format === 'elrc' ? ' (word-timed)' : format.startsWith('ai-') || ['srt', 'json'].includes(format) ? ' (AI)' : ''
    const name = `${s.artist ? s.artist + ' - ' : ''}${s.title}${suffix}`.replace(/[<>:"/\\|?*]/g, '').slice(0, 140)
    const r = await dialog.showSaveDialog(win, { defaultPath: `${name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
    if (r.canceled || !r.filePath) return false
    await fs.writeFile(r.filePath, body, 'utf8')
    return true
  }))

  // Embed & Export: lyrics go into a new copy the user names; the original audio file is never written.
  ipcMain.handle('lyrics:embedExport', wrap(async (s: Song, which: unknown, sidecar: unknown) => {
    const file = str(s?.filePath)
    if (!AUDIO_EXT.includes(path.extname(file).slice(1).toLowerCase()) || !statSync(file).isFile()) throw new Error('That song has no local audio file.')
    let lrc: string | undefined, synced: TimedLine[] | undefined, plain: string | undefined
    if (which === 'ai' && s.ai) {
      lrc = toLrc(s.ai, { title: s.title, artist: s.artist, album: s.album })
      synced = s.ai.lines.filter((l) => l.kind === 'vocal' && l.words.length).map((l) => ({ time: l.start, text: lineText(l) }))
    } else if (which === 'synced' && s.syncedLyrics) {
      synced = parseLrc(s.syncedLyrics).filter((l) => l.text)
      lrc = toLrcText(synced)
    } else if (which === 'plain') plain = s.plainLyrics || (s.syncedLyrics ? lrcToPlain(s.syncedLyrics) : undefined)
    const tag = lrc ?? plain
    if (!tag) throw new Error("this song doesn't have those lyrics yet 🤷")
    const ext = path.extname(file)
    const r = await dialog.showSaveDialog(win, {
      title: 'Export audio with embedded lyrics',
      defaultPath: path.join(path.dirname(file), `${path.basename(file, ext)} (with lyrics)${ext}`),
      filters: [{ name: `${ext.slice(1).toUpperCase()} audio`, extensions: [ext.slice(1)] }],
    })
    if (r.canceled || !r.filePath) return null
    const res = await embedLyricsCopy(file, r.filePath, tag, synced)
    let sidecarPath: string | undefined
    if (sidecar && lrc) { sidecarPath = r.filePath.slice(0, -path.extname(r.filePath).length) + '.lrc'; await fs.writeFile(sidecarPath, lrc, 'utf8') }
    return { path: r.filePath, synced: res.synced, sidecar: sidecarPath }
  }))
  ipcMain.handle('lyrics:openFile', wrap(async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import lyrics', properties: ['openFile'], filters: [{ name: 'Lyrics (.lrc, .txt)', extensions: ['lrc', 'txt'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const f = r.filePaths[0]
    if (!/\.(lrc|txt)$/i.test(f)) throw new Error('Choose a .lrc or .txt file.')
    if (statSync(f).size > 512 * 1024) throw new Error('that file is way too big to be lyrics (over 512 KB) 🤨')
    const buf = await fs.readFile(f)
    // Notepad often saves UTF-16; anything else is read as UTF-8.
    const raw = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf[0] === 0xfe && buf[1] === 0xff ? Buffer.from(buf).swap16().toString('utf16le') : buf.toString('utf8')
    if (raw.includes('\u0000')) throw new Error("that file isn't text, it's gibberish 🥴")
    const parsed = parseLyricsFile(raw)
    if (!parsed.text.trim()) throw new Error('that file is empty. no lyrics in sight 🔍')
    return { name: path.basename(f), ...parsed }
  }))
  ipcMain.handle('genius:search', wrap(async (q: unknown) => {
    const token = getKey('genius')
    if (!token) throw new Error('Add a Genius access token in AI providers to search Genius.')
    const query = str(q).trim().slice(0, 200)
    if (!query) throw new Error('type something first 😅 a title, an artist, or both')
    return searchGenius(token, query)
  }))
  ipcMain.handle('genius:lyrics', wrap(async (id: unknown) => {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) throw new Error('Unknown Genius song.')
    return (await geniusLyrics(id)) ?? null
  }))
  ipcMain.handle('queue:status', wrap(() => queueStatus()))
  ipcMain.handle('queue:cancel', wrap(() => cancelQueue()))
  ipcMain.handle('queue:import', wrap(async (o: { lyrics?: unknown; analyse?: AnalyzeOptions | null }) => {
    const r = await dialog.showOpenDialog(win, { title: 'Import a music folder', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return { folder: r.filePaths[0], found: importFolder(win, r.filePaths[0], { lyrics: !!o?.lyrics, analyse: o?.analyse ? cleanOpts(o.analyse) : null }, cacheRoot()) }
  }))
  ipcMain.handle('queue:analyseMissing', wrap((o: AnalyzeOptions) => analyseMissing(win, cleanOpts(o), cacheRoot())))
  ipcMain.handle('library:backup', wrap(async () => {
    const r = await dialog.showSaveDialog(win, { defaultPath: `Verse library ${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return false
    await fs.writeFile(r.filePath, JSON.stringify(lib.listSongs(), null, 1), 'utf8')
    return true
  }))
  ipcMain.handle('library:restore', wrap(async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    let data: unknown
    try { data = JSON.parse(await fs.readFile(r.filePaths[0], 'utf8')) } catch { throw new Error("that's not a Verse backup, nice try 😏") }
    const songs = Array.isArray(data) ? data.filter((x): x is Song => !!x && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.source === 'string') : []
    if (!songs.length) throw new Error("that's not a Verse backup, nice try 😏")
    // Merge: songs already in the library are kept as they are, so a restore never overwrites newer edits.
    const have = new Set(lib.listSongs().map((x) => x.id))
    const fresh = songs.filter((x) => !have.has(x.id))
    for (const x of fresh.reverse()) lib.saveSong(x)
    return { added: fresh.length, skipped: songs.length - fresh.length }
  }))
  // Lyrics sync to music playing in other apps on this PC. Watched only while a lyrics page asks for it.
  let unwatch: (() => void) | null = null
  ipcMain.handle('nowPlaying:watch', wrap((on: unknown) => {
    // Verse's own sessions (an embedded player inside the app) are not 'another app': syncing to them would follow a
    // 30-second preview as if it were the song.
    const own = (id: string) => id === APP_ID || id === 'electron.app.Electron' || /[\\/](electron|verse)\.exe$/i.test(id)
    if (on && !unwatch) unwatch = watchNowPlaying((p) => { if (!win.isDestroyed()) win.webContents.send('nowPlaying', p.filter((x) => !own(x.app))) })
    else if (!on && unwatch) { unwatch(); unwatch = null }
  }))
  ipcMain.handle('nowPlaying:control', wrap((appId: unknown, action: unknown) => {
    if (action !== 'toggle' && action !== 'next' && action !== 'prev') throw new Error('Invalid input.')
    return controlNowPlaying(str(appId), action)
  }))
  ipcMain.handle('nowPlaying:seek', wrap((appId: unknown, sec: unknown) => seekNowPlaying(str(appId), Number(sec))))
  app.on('will-quit', () => stopNowPlaying())
  ipcMain.handle('art:palette', wrap((src: unknown) => artPalette(str(src))))
  ipcMain.handle('shell:showItem', wrap((p: unknown) => shell.showItemInFolder(str(p))))
  ipcMain.handle('ai:providers', wrap(() => ({ available: providerStatus(), keys: keyStatus() })))
  ipcMain.handle('ai:setKey', wrap((name: unknown, value: unknown) => {
    if (typeof name !== 'string' || !(name in KEYS)) throw new Error('Unknown key.')
    setKey(name as KeyName, typeof value === 'string' ? value : null)
    return { available: providerStatus(), keys: keyStatus() }
  }))
  ipcMain.handle('ai:waveform', wrap(async (file: unknown) => {
    const f = str(file)
    const st = statSync(f)
    const k = `${f}:${st.size}:${st.mtimeMs}`
    if (!waveCache.has(k)) waveCache.set(k, peaks(await pcm(f), 1600))
    return waveCache.get(k)
  }))
  ipcMain.handle('ai:start', wrap((file: unknown, o: AnalyzeOptions) => {
    const f = str(file)
    const opts = cleanOpts(o)
    const id = randomUUID()
    const ac = new AbortController()
    jobs.set(id, ac)
    const send = (ch: string, payload: object) => { if (!win.isDestroyed()) win.webContents.send(ch, { jobId: id, ...payload }) }
    // Start on the next tick so the renderer receives the job id before the first progress event.
    setTimeout(() => analyze(f, opts, cacheRoot(), (e) => send('ai:event', e), ac.signal)
      .then((data) => {
        // Saved songs get the result even if the user left the analysis screen.
        const owners = lib.listSongs().filter((x) => x.filePath === f)
        for (const o of owners) lib.updateSong(o.id, { ai: data })
        if (owners.length) libraryChanged(win)
        notify(win, `Finished analysing ${opts.title ?? path.basename(f)}.`)
        send('ai:done', { ok: true, data })
      })
      .catch((e) => send('ai:done', { ok: false, cancelled: e instanceof Cancelled, message: e instanceof Error ? e.message : String(e) }))
      .finally(() => jobs.delete(id)), 0)
    return id
  }))
  ipcMain.handle('ai:cancel', wrap((id: unknown) => { jobs.get(str(id))?.abort() }))
  let install: AbortController | null = null
  ipcMain.handle('ai:installLocal', wrap(async (o?: { large?: unknown }) => {
    if (install) throw new Error('chill, the free engine is already downloading ⏳')
    install = new AbortController()
    try {
      await installLocal(install.signal, (p) => { if (!win.isDestroyed()) win.webContents.send('ai:install', p) }, { large: !!o?.large })
      return { available: providerStatus(), keys: keyStatus() }
    } finally { install = null }
  }))
  ipcMain.handle('ai:cancelInstall', wrap(() => { install?.abort() }))

  createWindow()
  startUpdates(() => (win && !win.isDestroyed() ? win : undefined))
})

app.on('window-all-closed', () => app.quit())

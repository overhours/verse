import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { notesText } from './parse'

export type ReadyUpdate = { version: string; notes: string }

// Checks overhours/verse-updates every 2 minutes and downloads new versions in the background.
export function startUpdates(getWin: () => BrowserWindow | undefined) {
  let ready: ReadyUpdate | null = null
  let busy = false // a check or download is in flight; overlapping ones would start a second download
  ipcMain.handle('update:status', () => ({ ok: true, data: ready }))
  ipcMain.handle('update:install', () => {
    if (!ready) return { ok: false, message: 'No update is ready.' }
    // Silent NSIS run (no setup wizard), then Verse reopens on the new version. Small delay lets the reply reach the page.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 300)
    return { ok: true, data: true }
  })
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (i) => {
    ready = { version: i.version, notes: notesText(i.releaseNotes) }
    getWin()?.webContents.send('update', ready)
  })
  const check = async () => {
    if (busy || ready) return
    busy = true
    try { await (await autoUpdater.checkForUpdates())?.downloadPromise }
    catch { /* offline or GitHub hiccup: the next tick retries */ }
    finally { busy = false }
  }
  check()
  setInterval(check, 2 * 60 * 1000)
}

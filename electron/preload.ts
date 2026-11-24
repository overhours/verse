import { contextBridge, ipcRenderer, webUtils } from 'electron'

const call = (ch: string) => (...a: unknown[]) => ipcRenderer.invoke(ch, ...a)

contextBridge.exposeInMainWorld('ipc', {
  link: call('track:link'),
  file: call('track:file'),
  pick: call('track:pick'),
  lyrics: call('lyrics:find'),
  list: call('library:list'),
  save: call('library:save'),
  update: call('library:update'),
  remove: call('library:delete'),
  exportLyrics: call('lyrics:export'),
  embedExport: call('lyrics:embedExport'),
  openLyricsFile: call('lyrics:openFile'),
  geniusSearch: call('genius:search'),
  geniusLyrics: call('genius:lyrics'),
  showInFolder: call('shell:showItem'),
  artPalette: call('art:palette'),
  nowPlayingWatch: call('nowPlaying:watch'),
  nowPlayingSeek: call('nowPlaying:seek'),
  nowPlayingControl: call('nowPlaying:control'),
  onNowPlaying: (cb: (p: unknown) => void) => { const h = (_: unknown, p: unknown) => cb(p); ipcRenderer.on('nowPlaying', h); return () => { ipcRenderer.off('nowPlaying', h) } },
  queueStatus: call('queue:status'),
  queueCancel: call('queue:cancel'),
  queueImport: call('queue:import'),
  analyseMissing: call('queue:analyseMissing'),
  backupLibrary: call('library:backup'),
  restoreLibrary: call('library:restore'),
  onQueue: (cb: (p: unknown) => void) => { const h = (_: unknown, p: unknown) => cb(p); ipcRenderer.on('queue', h); return () => { ipcRenderer.off('queue', h) } },
  updateStatus: call('update:status'),
  updateInstall: call('update:install'),
  onUpdate: (cb: (p: unknown) => void) => { const h = (_: unknown, p: unknown) => cb(p); ipcRenderer.on('update', h); return () => { ipcRenderer.off('update', h) } },
  onLibraryChanged: (cb: () => void) => { const h = () => cb(); ipcRenderer.on('library:changed', h); return () => { ipcRenderer.off('library:changed', h) } },
  pathFor: (f: File) => webUtils.getPathForFile(f),
  aiProviders: call('ai:providers'),
  aiSetKey: call('ai:setKey'),
  aiWaveform: call('ai:waveform'),
  aiStart: call('ai:start'),
  aiCancel: call('ai:cancel'),
  aiInstallLocal: call('ai:installLocal'),
  aiCancelInstall: call('ai:cancelInstall'),
  onInstall: (cb: (p: unknown) => void) => { const h = (_: unknown, p: unknown) => cb(p); ipcRenderer.on('ai:install', h); return () => { ipcRenderer.off('ai:install', h) } },
  onAi: (cb: (channel: 'event' | 'done', payload: unknown) => void) => {
    const ev = (_: unknown, p: unknown) => cb('event', p)
    const done = (_: unknown, p: unknown) => cb('done', p)
    ipcRenderer.on('ai:event', ev)
    ipcRenderer.on('ai:done', done)
    return () => { ipcRenderer.off('ai:event', ev); ipcRenderer.off('ai:done', done) }
  },
})

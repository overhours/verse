import type { LyricsMatch, Song, Track } from '../electron/parse'
import type { AiLyrics, AnalyzeOptions, JobEvent, StageId } from '../electron/timed'
import type { Palette } from '../electron/palette'
import type { Playing } from '../electron/parse'

export type { AiLyrics, AnalyzeOptions, JobEvent, LyricsMatch, Palette, Playing, Song, StageId, Track }

type Result<T> = { ok: true; data: T } | { ok: false; message: string }
type Fn = (...a: unknown[]) => Promise<Result<unknown>>
export type AiDone = { jobId: string; ok: true; data: AiLyrics } | { jobId: string; ok: false; cancelled: boolean; message: string }
declare global {
  interface Window {
    ipc: Record<string, Fn> & {
      pathFor: (f: File) => string
      onAi: (cb: (channel: 'event' | 'done', payload: unknown) => void) => () => void
      onInstall: (cb: (p: unknown) => void) => () => void
      onQueue: (cb: (p: unknown) => void) => () => void
      onLibraryChanged: (cb: () => void) => () => void
      onNowPlaying: (cb: (p: unknown) => void) => () => void
      onUpdate: (cb: (p: unknown) => void) => () => void
    }
  }
}

export type KeyName = 'replicate' | 'openai' | 'anthropic' | 'huggingface' | 'genius'
export interface Providers {
  available: { whisperx: boolean; openai: boolean; local: boolean; localSeparation: boolean; localMissingBytes: number; localLarge: boolean; separation: boolean; refine: boolean; claude: boolean; diarize: boolean }
  keys: Record<KeyName, 'env' | 'saved' | null>
}
export interface QueueStatus { running: boolean; phase: 'import' | 'analyse' | 'idle'; done: number; total: number; current?: string; message?: string; errors: number; summary?: string }
export type LyricsFile = { name: string; text: string; timed?: { time: number; text: string }[] }
export type { GeniusHit } from '../electron/parse'
import type { GeniusHit } from '../electron/parse'
export type ExportFormat = 'txt' | 'lrc' | 'ai-lrc' | 'elrc' | 'srt' | 'json' | 'ai-txt'

const call = <T>(ch: string) => async (...a: unknown[]): Promise<T> => {
  const r = await window.ipc[ch](...a)
  if (!r.ok) throw new Error(r.message)
  return r.data as T
}

export const api = {
  link: call<Track>('link') as (url: string) => Promise<Track>,
  file: call<Track>('file') as (path: string) => Promise<Track>,
  pick: call<Track | null>('pick') as () => Promise<Track | null>,
  lyrics: call<{ best?: LyricsMatch; candidates: LyricsMatch[] }>('lyrics') as
    (q: { title: string; artist: string; durationSec?: number }) => Promise<{ best?: LyricsMatch; candidates: LyricsMatch[] }>,
  list: call<Song[]>('list') as () => Promise<Song[]>,
  save: call<Song>('save') as (s: Song) => Promise<Song>,
  update: call<Song>('update') as (id: string, patch: Partial<Song>) => Promise<Song>,
  remove: call<void>('remove') as (id: string) => Promise<void>,
  exportLyrics: call<boolean>('exportLyrics') as (s: Song, format: ExportFormat) => Promise<boolean>,
  pathFor: (f: File) => window.ipc.pathFor(f),
  embedExport: call<{ path: string; synced: boolean; sidecar?: string } | null>('embedExport') as (s: Song, which: 'ai' | 'synced' | 'plain', sidecar: boolean) => Promise<{ path: string; synced: boolean; sidecar?: string } | null>,
  openLyricsFile: call<LyricsFile | null>('openLyricsFile') as () => Promise<LyricsFile | null>,
  geniusSearch: call<GeniusHit[]>('geniusSearch') as (q: string) => Promise<GeniusHit[]>,
  geniusLyrics: call<string | null>('geniusLyrics') as (id: number) => Promise<string | null>,
  showInFolder: call<void>('showInFolder') as (path: string) => Promise<void>,
  artPalette: call<Palette | null>('artPalette') as (src: string) => Promise<Palette | null>,
  nowPlayingWatch: call<void>('nowPlayingWatch') as (on: boolean) => Promise<void>,
  nowPlayingSeek: call<boolean>('nowPlayingSeek') as (app: string, seconds: number) => Promise<boolean>,
  nowPlayingControl: call<boolean>('nowPlayingControl') as (app: string, action: 'toggle' | 'next' | 'prev') => Promise<boolean>,
  onNowPlaying: (cb: (p: Playing[]) => void) => window.ipc.onNowPlaying((p) => cb(p as Playing[])),
  queueStatus: call<QueueStatus>('queueStatus') as () => Promise<QueueStatus>,
  queueCancel: call<void>('queueCancel') as () => Promise<void>,
  queueImport: call<{ folder: string; found: number } | null>('queueImport') as (o: { lyrics: boolean; analyse: AnalyzeOptions | null }) => Promise<{ folder: string; found: number } | null>,
  analyseMissing: call<number>('analyseMissing') as (o: AnalyzeOptions) => Promise<number>,
  backupLibrary: call<boolean>('backupLibrary') as () => Promise<boolean>,
  restoreLibrary: call<{ added: number; skipped: number } | null>('restoreLibrary') as () => Promise<{ added: number; skipped: number } | null>,
  onQueue: (cb: (s: QueueStatus) => void) => window.ipc.onQueue((p) => cb(p as QueueStatus)),
  onLibraryChanged: (cb: () => void) => window.ipc.onLibraryChanged(cb),
  aiProviders: call<Providers>('aiProviders') as () => Promise<Providers>,
  aiSetKey: call<Providers>('aiSetKey') as (name: KeyName, value: string | null) => Promise<Providers>,
  aiWaveform: call<number[]>('aiWaveform') as (file: string) => Promise<number[]>,
  aiStart: call<string>('aiStart') as (file: string, o: AnalyzeOptions) => Promise<string>,
  aiCancel: call<void>('aiCancel') as (jobId: string) => Promise<void>,
  aiInstallLocal: call<Providers>('aiInstallLocal') as (o?: { large?: boolean }) => Promise<Providers>,
  aiCancelInstall: call<void>('aiCancelInstall') as () => Promise<void>,
  onInstall: (cb: (p: { fraction: number; message: string; total: number }) => void) => window.ipc.onInstall((p) => cb(p as { fraction: number; message: string; total: number })),
  onAi: (cb: (channel: 'event', p: JobEvent & { jobId: string }) => void, done: (p: AiDone) => void) =>
    window.ipc.onAi((ch, p) => (ch === 'event' ? cb('event', p as JobEvent & { jobId: string }) : done(p as AiDone))),
}

export const withLyrics = (s: Song, m?: LyricsMatch): Song => ({
  ...s, lyricsId: m?.id, plainLyrics: m?.plainLyrics, syncedLyrics: m?.syncedLyrics, instrumental: m?.instrumental,
})

export const fmtTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

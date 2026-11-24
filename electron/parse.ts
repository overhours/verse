// Pure helpers shared by the main process and the UI. No Node or DOM imports.
import type { AiLyrics } from './timed'

export type Source = 'spotify' | 'soundcloud' | 'youtube' | 'file' | 'search'

export interface Track {
  title: string
  artist: string
  album?: string
  durationSec?: number
  artwork?: string
  source: Source
  sourceUrl?: string
  filePath?: string
  audioUrl?: string
}

export interface LyricsMatch {
  id: number
  title: string
  artist: string
  album?: string
  durationSec?: number
  instrumental: boolean
  plainLyrics?: string
  syncedLyrics?: string
  source?: string // which lyrics database it came from
}

// lyrics.ovh returns one plain-text match; it sometimes prefixes a French "Paroles de la chanson … par …" header line.
export function parseLyricsOvh(o: { lyrics?: string }, title: string, artist: string): LyricsMatch | undefined {
  const text = (o.lyrics ?? '').replace(/\r\n?/g, '\n').replace(/^Paroles de la chanson .*\n/, '').trim()
  return text ? { id: -1, title, artist, instrumental: false, plainLyrics: text, source: 'lyrics.ovh' } : undefined
}

export interface Song extends Track {
  id: string
  lyricsId?: number
  plainLyrics?: string
  syncedLyrics?: string
  instrumental?: boolean
  ai?: AiLyrics
  favorite: boolean
  savedAt: number
}

export type Input = { kind: 'spotify'; id: string } | { kind: 'soundcloud'; url: string } | { kind: 'youtube'; id: string; music: boolean }

export function detectInput(raw: string): Input | null {
  const s = raw.trim()
  const sp = s.match(/^(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/i) ?? s.match(/^spotify:track:([A-Za-z0-9]{22})$/)
  if (sp) return { kind: 'spotify', id: sp[1] }
  const sc = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?(soundcloud\.com\/[^\s?#]+|on\.soundcloud\.com\/[^\s?#]+)/i)
  if (sc) return { kind: 'soundcloud', url: 'https://' + sc[1].replace(/^m\./, '') }
  const yt = s.match(/^(?:https?:\/\/)?(?:(?:www\.|m\.|(music)\.)?youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i)
  if (yt) return { kind: 'youtube', id: yt[2], music: !!yt[1] }
  return null
}

// YouTube oEmbed gives "<title>" + channel; music uploads use "Artist - Topic" channels or "Artist - Title" video names.
export function parseYoutubeOembed(o: { title?: string; author_name?: string; thumbnail_url?: string }, url: string): Track {
  if (!o.title) throw new Error('YouTube did not return video details for that link.')
  const split = splitArtistTitle(o.title)
  const artist = split?.artist ?? (o.author_name ?? '').replace(/\s+-\s+Topic$/, '').replace(/VEVO$/, '')
  return { title: split?.title ?? o.title, artist, artwork: o.thumbnail_url, source: 'youtube', sourceUrl: url }
}

// open.spotify.com/embed/track/<id> ships the track entity as Next.js page data.
export function parseSpotifyEmbed(html: string, id: string): Track {
  const json = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1]
  const ent = json && JSON.parse(json)?.props?.pageProps?.state?.data?.entity
  if (!ent?.name) throw new Error('Spotify did not return track details for that link.')
  const images: { url: string; maxWidth?: number }[] = ent.visualIdentity?.image ?? ent.coverArt?.sources ?? []
  return {
    title: ent.name,
    artist: (ent.artists ?? []).map((a: { name: string }) => a.name).join(', ') || ent.subtitle || '',
    durationSec: ent.duration ? Math.round(ent.duration / 1000) : undefined,
    artwork: [...images].sort((a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0))[0]?.url,
    source: 'spotify',
    sourceUrl: `https://open.spotify.com/track/${id}`,
  }
}

// SoundCloud oEmbed titles look like "<track> by <uploader>"; uploaders often put "Artist - Title" in the track name.
export function parseSoundcloudOembed(o: { title?: string; author_name?: string; thumbnail_url?: string }, url: string): Track {
  if (!o.title) throw new Error('SoundCloud did not return track details for that link.')
  const author = o.author_name ?? ''
  let title = author && o.title.endsWith(` by ${author}`) ? o.title.slice(0, -(` by ${author}`.length)) : o.title
  let artist = author
  const split = splitArtistTitle(title)
  if (split) ({ artist, title } = split)
  return { title, artist, artwork: o.thumbnail_url, source: 'soundcloud', sourceUrl: url }
}

export function splitArtistTitle(s: string): { artist: string; title: string } | null {
  const m = s.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  return m ? { artist: m[1].trim(), title: m[2].trim() } : null
}

export function parseFilename(name: string): { artist: string; title: string } {
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_/g, ' ').replace(/^\d{1,3}[\s.-]+/, '').trim()
  return splitArtistTitle(base) ?? { artist: '', title: base }
}

// Strips decorations that stop lyric databases matching: "(Official Video)", "[Lyrics]", "- Remastered 2011", "(feat. X)".
export function cleanTitle(t: string): string {
  return t
    .replace(/\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|live|hd|hq|explicit|clean|prod|feat|ft)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+[-–—]\s+.*(remaster|version|edit|mix|live|mono|stereo).*$/i, '')
    .replace(/\s+(feat\.?|ft\.?)\s+.*$/i, '')
    .trim() || t.trim()
}

export const primaryArtist = (a: string) => a.split(/\s*(?:,|&|\bx\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)[0].trim()

// Prefers the right length, then synced lyrics, then anything with words.
export function pickBest(matches: LyricsMatch[], durationSec?: number): LyricsMatch | undefined {
  const score = (m: LyricsMatch) => {
    let s = 0
    if (durationSec && m.durationSec) s -= Math.min(Math.abs(durationSec - m.durationSec), 60)
    if (m.syncedLyrics) s += 5
    if (m.plainLyrics || m.instrumental) s += 10
    return s
  }
  return [...matches].sort((a, b) => score(b) - score(a))[0]
}

export interface LrcLine { time: number; text: string }

export function parseLrc(lrc: string): LrcLine[] {
  const out: LrcLine[] = []
  for (const line of lrc.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)]
    if (!stamps.length) continue
    // Enhanced LRC carries per-word <mm:ss.xx> tags; strip them for line display.
    // Strip only time tags: text such as [unclear] is part of the lyric.
    const text = line.replace(/\[\d+:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').replace(/<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim()
    for (const [, m, s] of stamps) out.push({ time: Number(m) * 60 + Number(s.replace(':', '.')), text })
  }
  return out.sort((a, b) => a.time - b.time)
}

export function lineAt(lines: LrcLine[], t: number): number {
  let lo = 0, hi = lines.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

export const lrcToPlain = (lrc: string) => parseLrc(lrc).map((l) => l.text).join('\n')

// Reads an uploaded .lrc/.txt. LRC keeps its timestamps (in time order); plain text keeps its line breaks and sections.
export function parseLyricsFile(raw: string): { text: string; timed?: LrcLine[] } {
  const clean = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (/^\s*\[\d+:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(clean)) {
    const timed = parseLrc(clean).filter((l) => l.text)
    return { text: timed.map((l) => l.text).join('\n'), timed }
  }
  const text = clean.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text }
}

export const toLrcText = (lines: LrcLine[]) => lines.map((l) => {
  const cs = Math.round(l.time * 100)
  return `[${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]${l.text}`
}).join('\n')

// A media app's session on this PC, as Windows reports it (position in seconds, updated = epoch ms of that position).
export interface Playing { app: string; title: string; artist: string; status: string; position: number; end: number; updated: number; art?: string } // art: data: URL, sent once per song

const fold = (t: string) => cleanTitle(t).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// Finds the media session on this PC that is playing this song: same title (ignoring "Remastered", "feat." and
// punctuation) and an overlapping artist. Browser tabs often report "Artist - Title (Official Video)" with no artist,
// so then both have to appear in the tab title. A playing session wins over a paused one.
export function matchPlaying(song: { title: string; artist: string }, sessions: Playing[]): Playing | undefined {
  const t = fold(song.title), a = fold(primaryArtist(song.artist || ''))
  if (!t) return undefined
  const hits = sessions.filter((p) => {
    const pt = fold(p.title || ''), pa = fold(p.artist || '')
    if (!pt) return false
    if (pa) return (pt === t || pt.startsWith(t + ' ') || t.startsWith(pt + ' ')) && (!a || pa.includes(a) || a.includes(pa))
    const whole = ` ${pt} `
    return whole.includes(` ${t} `) && (!a || whole.includes(` ${a} `))
  })
  return hits.find((p) => p.status === 'Playing') ?? hits[0]
}

// A readable name for the app behind a media session.
export function appName(id: string): string {
  const s = id.toLowerCase()
  return s.includes('spotify') ? 'Spotify' : s.includes('applemusic') || s.includes('appleinc') ? 'Apple Music' : s.includes('zunemusic') || s.includes('mediaplayer') ? 'Media Player'
    : s.includes('chrome') ? 'Chrome' : s.includes('msedge') || s.includes('edge') ? 'Edge' : s.includes('firefox') ? 'Firefox' : s.includes('brave') ? 'Brave'
    : s.includes('opera') ? 'Opera' : s.includes('tidal') ? 'TIDAL' : s.includes('deezer') ? 'Deezer' : s.includes('amazon') ? 'Amazon Music' : s.includes('youtube') ? 'YouTube Music'
    : (id.split(/[!\\/]/).pop() ?? '').replace(/\.exe$/i, '').split('.').pop() || 'a media app' // 'electron.app.Electron' → 'Electron'
}

export interface GeniusHit { id: number; title: string; artist: string; art?: string; url: string; year?: string }

// GitHub release bodies arrive as HTML; the update screen shows a short plain-text summary.
export const notesText = (n: string | { note: string | null }[] | null | undefined) => {
  const raw = Array.isArray(n) ? n.map((x) => x.note ?? '').join('\n') : n ?? ''
  const text = raw.replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
  return text.length > 600 ? text.slice(0, 597) + '...' : text
}

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { geniusLyrics, searchGenius } from './genius'
import { getKey } from './keys'
import { cleanTitle, detectInput, LyricsMatch, parseFilename, parseLyricsOvh, parseSoundcloudOembed, parseSpotifyEmbed, parseYoutubeOembed, pickBest, primaryArtist, Track } from './parse'

const UA = 'Verse/1.0 (desktop lyrics app)'
export const AUDIO_EXT = ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus', 'aac']

async function get(url: string, headers: Record<string, string> = {}) {
  let res: Response
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(15000) })
  } catch {
    throw new Error('the internet ghosted us 👻 check your connection and try again.')
  }
  if (res.status === 404) throw new Error("couldn't find that track 🕵️ is the link public?")
  if (!res.ok) throw new Error(`the service tripped over itself (${res.status}) 🤕 try again in a sec.`)
  return res
}

export async function resolveLink(raw: string): Promise<Track> {
  const input = detectInput(raw)
  if (!input) throw new Error('paste a Spotify, SoundCloud or YouTube link pls')
  if (input.kind === 'spotify') {
    const html = await (await get(`https://open.spotify.com/embed/track/${input.id}`, { 'User-Agent': 'Mozilla/5.0' })).text()
    return parseSpotifyEmbed(html, input.id)
  }
  if (input.kind === 'youtube') {
    const watch = `https://www.youtube.com/watch?v=${input.id}` // oEmbed only accepts www.youtube.com URLs
    const o = await (await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`)).json()
    return parseYoutubeOembed(o, input.music ? `https://music.youtube.com/watch?v=${input.id}` : watch)
  }
  const o = await (await get(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(input.url)}`)).json()
  return parseSoundcloudOembed(o, input.url)
}

export async function resolveFile(file: string): Promise<Track> {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (!AUDIO_EXT.includes(ext)) throw new Error("can't play that file type 😬 try an MP3 or another normal audio file.")
  const { parseFile } = await import('music-metadata')
  const fromName = parseFilename(file)
  let common: Awaited<ReturnType<typeof parseFile>>['common'] | undefined
  let duration: number | undefined
  try {
    const meta = await parseFile(file, { duration: true })
    common = meta.common
    duration = meta.format.duration
  } catch { /* unreadable tags: fall back to the filename */ }
  const pic = common?.picture?.[0]
  return {
    title: common?.title || cleanTitle(fromName.title),
    artist: common?.artist || common?.albumartist || fromName.artist,
    album: common?.album,
    durationSec: duration ? Math.round(duration) : undefined,
    // shortcut: cover art is stored inline as a data URL; move to files on disk if libraries get large.
    artwork: pic ? `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}` : undefined,
    source: 'file',
    filePath: file,
    audioUrl: pathToFileURL(file).href,
  }
}

type LrclibRow = { id: number; trackName: string; artistName: string; albumName?: string; duration?: number; instrumental: boolean; plainLyrics?: string | null; syncedLyrics?: string | null }

const toMatch = (r: LrclibRow): LyricsMatch => ({
  id: r.id, title: r.trackName, artist: r.artistName, album: r.albumName || undefined, durationSec: r.duration ? Math.round(r.duration) : undefined,
  instrumental: r.instrumental, plainLyrics: r.plainLyrics || undefined, syncedLyrics: r.syncedLyrics || undefined, source: 'LRCLIB',
})

// Extra source for variety; it needs an exact artist + title and its failures never block the LRCLIB results.
async function lyricsOvh(title: string, artist: string): Promise<LyricsMatch[]> {
  if (!artist) return []
  try {
    const m = parseLyricsOvh(await (await get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`)).json(), title, artist)
    return m ? [m] : []
  } catch { return [] }
}

async function lrclib(params: Record<string, string>): Promise<LyricsMatch[]> {
  const rows: LrclibRow[] = await (await get(`https://lrclib.net/api/search?${new URLSearchParams(params)}`)).json()
  return rows.map(toMatch).filter((m) => m.plainLyrics || m.syncedLyrics || m.instrumental)
}

// Only runs when the user has added a Genius token; takes the top search hit.
async function genius(title: string, artist: string): Promise<LyricsMatch[]> {
  const token = getKey('genius')
  if (!token) return []
  try {
    const hit = (await searchGenius(token, `${title} ${artist}`.trim()))[0]
    const text = hit && await geniusLyrics(hit.id)
    return text ? [{ id: -hit.id - 1, title: hit.title, artist: hit.artist, instrumental: false, plainLyrics: text, source: 'Genius' }] : []
  } catch { return [] }
}

// Tries the precise search first, then looser free-text searches.
export async function findLyrics(q: { title: string; artist: string; durationSec?: number }) {
  const title = cleanTitle(q.title)
  const artist = primaryArtist(q.artist)
  if (!title) throw new Error('gotta give me a song title to search for 😅')
  const ovh = lyricsOvh(title, artist)
  const gen = genius(title, artist)
  let candidates = artist ? await lrclib({ track_name: title, artist_name: artist }) : []
  if (!candidates.length) candidates = await lrclib({ q: `${title} ${artist}`.trim() })
  if (!candidates.length && artist) candidates = await lrclib({ q: title })
  candidates = [...candidates.slice(0, 10), ...(await gen), ...(await ovh)]
  return { best: pickBest(candidates, q.durationSec), candidates }
}

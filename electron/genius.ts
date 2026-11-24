import { errorText, fetchRetry } from './net'
import type { GeniusHit } from './parse'

export type { GeniusHit }

type Raw = { response?: { hits?: { type?: string; result?: {
  id: number; title: string; url: string; primary_artist?: { name?: string }; artist_names?: string
  song_art_image_thumbnail_url?: string; header_image_thumbnail_url?: string; release_date_components?: { year?: number } | null
} }[] } }

// Genius's API returns song metadata only. Lyrics come from Genius's public embed widget (genius.com/songs/<id>/embed.js),
// the script Genius gives other sites to show a song's lyrics.
export function parseGeniusSearch(json: Raw): GeniusHit[] {
  return (json.response?.hits ?? [])
    .filter((h) => h.type === 'song' && h.result)
    .map(({ result: r }) => ({
      id: r!.id, title: r!.title, artist: r!.primary_artist?.name ?? r!.artist_names ?? '', url: r!.url,
      art: r!.song_art_image_thumbnail_url || r!.header_image_thumbnail_url || undefined,
      year: r!.release_date_components?.year ? String(r!.release_date_components.year) : undefined,
    }))
}

export async function searchGenius(token: string, q: string): Promise<GeniusHit[]> {
  const res = await fetchRetry(`https://api.genius.com/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } }, 3, 'Genius')
  if (!res.ok) throw new Error(await errorText(res, 'Genius'))
  return parseGeniusSearch(await res.json())
}

// Electron's net uses Chromium's network stack; Node's fetch gets a 403 from Genius's CDN for the same public URL.
// shortcut: depends on the embed's markup; if Genius changes it this returns undefined and the other sources still work.
export async function geniusLyrics(songId: number): Promise<string | undefined> {
  const { net } = await import('electron')
  const res = await net.fetch(`https://genius.com/songs/${songId}/embed.js`)
  if (!res.ok) return undefined
  return parseGeniusEmbed(await res.text())
}

// The embed is `document.write(JSON.parse('<escaped HTML>'))`; the lyrics sit in .rg_embed_body as <br>-separated lines.
export function parseGeniusEmbed(js: string): string | undefined {
  const lit = js.match(/JSON\.parse\('([\s\S]*?)'\)\)/)?.[1]
  if (!lit) return undefined
  let html: string
  try { html = JSON.parse(lit.replace(/\\(.)/g, '$1')) } catch { return undefined }
  const body = html.split(/class="rg_embed_body"[^>]*>/)[1]?.split(/<div class="rg_embed_footer"/)[0]
  if (!body) return undefined
  const text = body.replace(/<br\s*\/?>\n?/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text || undefined
}

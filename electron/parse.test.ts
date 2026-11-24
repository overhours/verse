import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGeniusEmbed, parseGeniusSearch } from './genius'

test('extracts lyrics from the Genius embed script', () => {
  const html = '<div class="rg_embed_header">Powered by Genius</div><div class="rg_embed_body"><p>[Chorus]<br>\n<a href="x">Don&#39;t stop &amp; go</a><br>\nLine two</p></div><div class="rg_embed_footer">Song</div>'
  const js = `if (x) {\n  document.write(JSON.parse('${JSON.stringify(html).replace(/[\\"]/g, '\\$&').replace(/\//g, '\\/')}'))\n}`
  assert.equal(parseGeniusEmbed(js), "[Chorus]\nDon't stop & go\nLine two")
  assert.equal(parseGeniusEmbed('nothing here'), undefined)
})
import { cleanTitle, detectInput, lineAt, parseLyricsFile, toLrcText, parseFilename, parseLrc, parseSoundcloudOembed, parseSpotifyEmbed, pickBest, primaryArtist, appName, matchPlaying, parseLyricsOvh, parseYoutubeOembed, notesText } from './parse'

test('parses lyrics.ovh, dropping its French header line', () => {
  assert.equal(parseLyricsOvh({ lyrics: 'Paroles de la chanson Song par Band\r\nLine one\r\nLine two' }, 'Song', 'Band')?.plainLyrics, 'Line one\nLine two')
  assert.equal(parseLyricsOvh({ lyrics: '' }, 'Song', 'Band'), undefined)
})

test('detects links', () => {
  assert.deepEqual(detectInput('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc'), { kind: 'spotify', id: '4cOdK2wGLETKBW3PvgPWqT' })
  assert.deepEqual(detectInput('open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT'), { kind: 'spotify', id: '4cOdK2wGLETKBW3PvgPWqT' })
  assert.deepEqual(detectInput('spotify:track:4cOdK2wGLETKBW3PvgPWqT'), { kind: 'spotify', id: '4cOdK2wGLETKBW3PvgPWqT' })
  assert.deepEqual(detectInput('https://m.soundcloud.com/forss/flickermood?in=x'), { kind: 'soundcloud', url: 'https://soundcloud.com/forss/flickermood' })
  assert.equal(detectInput('https://open.spotify.com/album/4cOdK2wGLETKBW3PvgPWqT'), null)
  assert.equal(detectInput('hello'), null)
  const yt = { kind: 'youtube', id: 'dQw4w9WgXcQ', music: false }
  assert.deepEqual(detectInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1'), yt)
  assert.deepEqual(detectInput('youtube.com/watch?list=x&v=dQw4w9WgXcQ'), yt)
  assert.deepEqual(detectInput('https://youtu.be/dQw4w9WgXcQ?si=a'), yt)
  assert.deepEqual(detectInput('https://www.youtube.com/shorts/dQw4w9WgXcQ'), yt)
  assert.deepEqual(detectInput('https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=a'), { ...yt, music: true })
  assert.equal(detectInput('https://www.youtube.com/@channel'), null)
})

test('parses youtube oembed titles', () => {
  const t = (title: string, author_name: string) => { const r = parseYoutubeOembed({ title, author_name }, 'u'); return [r.artist, r.title] }
  assert.deepEqual(t('Rick Astley - Never Gonna Give You Up (Official Video)', 'Rick Astley'), ['Rick Astley', 'Never Gonna Give You Up (Official Video)'])
  assert.deepEqual(t('Blinding Lights', 'The Weeknd - Topic'), ['The Weeknd', 'Blinding Lights'])
  assert.throws(() => parseYoutubeOembed({}, 'u'))
})

test('parses spotify embed data', () => {
  const data = { props: { pageProps: { state: { data: { entity: { name: 'Song', artists: [{ name: 'A' }, { name: 'B' }], duration: 213573,
    visualIdentity: { image: [{ url: 'small', maxWidth: 64 }, { url: 'big', maxWidth: 640 }] } } } } } } }
  const t = parseSpotifyEmbed(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`, 'x')
  assert.equal(t.title, 'Song'); assert.equal(t.artist, 'A, B'); assert.equal(t.durationSec, 214); assert.equal(t.artwork, 'big')
  assert.throws(() => parseSpotifyEmbed('<html></html>', 'x'))
})

test('parses soundcloud titles', () => {
  assert.deepEqual(
    [parseSoundcloudOembed({ title: 'Flickermood by Forss', author_name: 'Forss' }, 'u')].map((t) => [t.artist, t.title])[0], ['Forss', 'Flickermood'])
  assert.deepEqual(
    [parseSoundcloudOembed({ title: 'Daft Punk - One More Time by randomuploader', author_name: 'randomuploader' }, 'u')].map((t) => [t.artist, t.title])[0],
    ['Daft Punk', 'One More Time'])
})

test('parses filenames and cleans titles', () => {
  assert.deepEqual(parseFilename('C:\\Music\\01 - Rick Astley - Never Gonna Give You Up.mp3'), { artist: 'Rick Astley', title: 'Never Gonna Give You Up' })
  assert.deepEqual(parseFilename('just_a_song.mp3'), { artist: '', title: 'just a song' })
  assert.equal(cleanTitle('Never Gonna Give You Up (Official Video) [4K]'), 'Never Gonna Give You Up [4K]')
  assert.equal(cleanTitle('Hey Jude - Remastered 2015'), 'Hey Jude')
  assert.equal(cleanTitle('Song (feat. Someone)'), 'Song')
  assert.equal(primaryArtist('Calvin Harris, Dua Lipa'), 'Calvin Harris')
  assert.equal(primaryArtist('Simon & Garfunkel'), 'Simon')
})

test('picks the closest-length match with lyrics', () => {
  const m = (id: number, d: number, synced = true) => ({ id, title: 't', artist: 'a', durationSec: d, instrumental: false, plainLyrics: 'x', syncedLyrics: synced ? 'x' : undefined })
  assert.equal(pickBest([m(1, 300), m(2, 214), m(3, 214, false)], 213)?.id, 2)
  assert.equal(pickBest([], 213), undefined)
})

test('parses LRC and finds the current line', () => {
  const lines = parseLrc('[ar:x]\n[00:19.32] We are\n[00:23.21][01:00.00] Chorus\n[00:30.5]\nbad line')
  assert.deepEqual(lines.map((l) => [l.time, l.text]), [[19.32, 'We are'], [23.21, 'Chorus'], [30.5, ''], [60, 'Chorus']])
  assert.deepEqual(parseLrc('[00:18.89] <00:18.89> We\'re <00:19.25> no <00:20.00>').map((l) => l.text), ["We're no"])
  assert.equal(lineAt(lines, 5), -1)
  assert.equal(lineAt(lines, 25), 1)
  assert.equal(lineAt(lines, 999), 3)
})

test('parseLyricsFile reads LRC (with metadata tags and BOM) and plain text (keeping sections)', () => {
  const lrc = parseLyricsFile('﻿[ar:Someone]\r\n[ti:Song]\r\n[00:12.50]First line\r\n[00:20.00]\r\n[00:15.00]Second line\r\n')
  assert.deepEqual(lrc.timed?.map((l) => [l.time, l.text]), [[12.5, 'First line'], [15, 'Second line']])
  assert.equal(lrc.text, 'First line\nSecond line')
  assert.equal(toLrcText(lrc.timed!), '[00:12.50]First line\n[00:15.00]Second line')
  const txt = parseLyricsFile('[Verse 1]\r\nHello there   \r\n\r\n\r\n\r\n[Chorus]\r\nOh oh\r\n')
  assert.equal(txt.timed, undefined)
  assert.equal(txt.text, '[Verse 1]\nHello there\n\n[Chorus]\nOh oh')
})

test('parses Genius API search results (songs only, primary artist, artwork, year)', () => {
  const hits = parseGeniusSearch({ response: { hits: [
    { type: 'song', result: { id: 84851, title: 'Never Gonna Give You Up', url: 'https://genius.com/Rick-astley-never-gonna-give-you-up-lyrics', primary_artist: { name: 'Rick Astley' },
      song_art_image_thumbnail_url: 'https://images.genius.com/a.300x300x1.jpg', release_date_components: { year: 1987 } } },
    { type: 'album', result: { id: 1, title: 'x', url: 'u' } },
    { type: 'song', result: { id: 2, title: 'Untitled', url: 'https://genius.com/u', artist_names: 'Somebody', release_date_components: null } },
  ] } })
  assert.deepEqual(hits, [
    { id: 84851, title: 'Never Gonna Give You Up', artist: 'Rick Astley', url: 'https://genius.com/Rick-astley-never-gonna-give-you-up-lyrics', art: 'https://images.genius.com/a.300x300x1.jpg', year: '1987' },
    { id: 2, title: 'Untitled', artist: 'Somebody', url: 'https://genius.com/u', art: undefined, year: undefined },
  ])
})

test('matchPlaying finds the session playing this song, tolerant of remasters, feat. and browser tab titles', () => {
  const s = (title: string, artist: string, status = 'Playing', app = 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify') => ({ app, title, artist, status, position: 10, end: 200, updated: 0 })
  const song = { title: 'Blinding Lights', artist: 'The Weeknd' }
  assert.equal(matchPlaying(song, [s('Something Else', 'The Weeknd'), s('Blinding Lights', 'The Weeknd')])?.title, 'Blinding Lights')
  assert.ok(matchPlaying(song, [s('Blinding Lights - 2020 Remaster', 'The Weeknd')]), 'remaster suffix')
  assert.ok(matchPlaying({ title: 'Stay (feat. Justin Bieber)', artist: 'The Kid LAROI, Justin Bieber' }, [s('STAY', 'The Kid LAROI, Justin Bieber')]), 'feat. and case')
  assert.ok(matchPlaying(song, [s('The Weeknd - Blinding Lights (Official Video)', '', 'Playing', 'chrome')]), 'browser tab title')
  assert.equal(matchPlaying(song, [s('Blinding Lights', 'Some Cover Band')]), undefined, 'same title, different artist')
  assert.equal(matchPlaying(song, [s('Lights', 'The Weeknd')]), undefined, 'a shorter different title')
  assert.equal(matchPlaying(song, [s('mori | TikTok', '', 'Playing', 'Brave')]), undefined)
  const paused = s('Blinding Lights', 'The Weeknd', 'Paused', 'chrome'), playing = s('Blinding Lights', 'The Weeknd')
  assert.equal(matchPlaying(song, [paused, playing]), playing, 'a playing session wins')
  assert.equal(appName('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'), 'Spotify')
  assert.equal(appName('Brave'), 'Brave')
  assert.equal(appName('electron.app.Electron'), 'Electron')
  assert.equal(appName('C:\\Apps\\foobar2000.exe'), 'foobar2000')
})

test('notesText turns GitHub release HTML into short plain text', () => {
  assert.equal(notesText('<h2>What&#39;s new</h2><ul><li>Faster sync</li><li>Fix &amp; polish</li></ul>'), "What's new\nFaster sync\nFix & polish")
  assert.equal(notesText([{ note: '<p>a</p>' }, { note: null }]), 'a')
  assert.equal(notesText(null), '')
  assert.equal(notesText('x'.repeat(700)).length, 600)
})

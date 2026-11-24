import fs from 'node:fs'
import path from 'node:path'
import type { Song } from './parse'

let file = ''
let songs: Song[] = []

export function openLibrary(dir: string) {
  file = path.join(dir, 'library.json')
  try {
    songs = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    // Keep a corrupt library aside instead of silently overwriting it.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    songs = []
  }
}

function persist() {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(songs))
  fs.renameSync(`${file}.tmp`, file)
}

export const listSongs = () => songs

export function saveSong(song: Song) {
  songs = [song, ...songs.filter((s) => s.id !== song.id)]
  persist()
  return song
}

export function updateSong(id: string, patch: Partial<Song>) {
  const i = songs.findIndex((s) => s.id === id)
  if (i < 0) throw new Error('that song left your library 👋')
  songs[i] = { ...songs[i], ...patch, id }
  persist()
  return songs[i]
}

export function deleteSong(id: string) {
  songs = songs.filter((s) => s.id !== id)
  persist()
}

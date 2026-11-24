import { useEffect, useState } from 'react'
import { api, Playing } from './api'

// What media apps on this PC are playing, refreshed a few times a second while any lyrics view needs it.
let subscribers = 0
// Cover art arrives only on the report where a song is new; remember it so every report carries it.
const arts = new Map<string, string>()
const withArt = (all: Playing[]) => all.map((p) => {
  const key = `${p.app}|${p.title}|${p.artist}`
  if (p.art) { if (arts.size > 50) arts.clear(); arts.set(key, p.art) }
  return arts.has(key) ? { ...p, art: arts.get(key) } : p
})

export function useNowPlaying(active: boolean): Playing[] {
  const [sessions, setSessions] = useState<Playing[]>([])
  useEffect(() => {
    if (!active) { setSessions([]); return }
    const off = api.onNowPlaying((all) => setSessions(withArt(all)))
    if (subscribers++ === 0) api.nowPlayingWatch(true).catch(() => {})
    return () => { off(); if (--subscribers === 0) api.nowPlayingWatch(false).catch(() => {}) }
  }, [active])
  return sessions
}

// Where that session is now: its last reported position plus the time since, while it plays.
export const sessionTime = (p: Playing) => p.position + (p.status === 'Playing' ? Math.max(0, (Date.now() - p.updated) / 1000) : 0)

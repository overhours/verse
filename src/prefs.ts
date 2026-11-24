import { useSyncExternalStore } from 'react'

// App preferences: kept on this PC only (localStorage), like the sidebar and sort choices.
export type Prefs = {
  lyricSize: 's' | 'm' | 'l' | 'xl'
  lyricView: 'synced' | 'plain'
  tint: boolean // colour the window from the song's artwork
  nowPlayingBar: boolean
  confirmRemove: boolean
  startListening: boolean // open "Listening now" on launch
  reduceMotion: boolean
}

export const DEFAULTS: Prefs = { lyricSize: 'm', lyricView: 'synced', tint: true, nowPlayingBar: true, confirmRemove: true, startListening: false, reduceMotion: false }
export const LYRIC_PX = { s: 24, m: 30, l: 38, xl: 46 }

const read = (): Prefs => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('prefs') ?? '{}') } } catch { return DEFAULTS } }
let prefs = read()
const subs = new Set<() => void>()

function apply() {
  const r = document.documentElement
  r.style.setProperty('--lyric-size', `${LYRIC_PX[prefs.lyricSize]}px`)
  r.classList.toggle('reduce-motion', prefs.reduceMotion)
}
apply()

export function setPrefs(p: Partial<Prefs> | null) {
  prefs = p ? { ...prefs, ...p } : DEFAULTS
  try { localStorage.setItem('prefs', JSON.stringify(prefs)) } catch { /* storage unavailable: lasts until restart */ }
  apply()
  subs.forEach((f) => f())
}

export const getPrefs = () => prefs
export const usePrefs = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, getPrefs)

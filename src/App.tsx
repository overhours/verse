import { DragEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowDownUp, AudioLines, Check, FileAudio, FolderInput, FileText, Headphones, Heart, Home, PanelLeftClose, PanelLeftOpen, Pause, Play, Search, Settings, SkipBack, SkipForward, Sparkles, X } from 'lucide-react'
import { detectInput, splitArtistTitle } from '../electron/parse'
import Analysis from './ai/Analysis'
import AiSettings from './ai/AiSettings'
import { AiLyrics, api, Playing, LyricsMatch, Providers, QueueStatus, Song, Track, withLyrics } from './api'
import SyncLyrics from './SyncLyrics'
import { analyseMissingSongs, ImportDialog, LibraryMenu, QueueCard } from './LibraryTools'
import SongView from './SongView'
import Updater from './Updater'
import Onboarding, { loadProfile, Profile, ProfileDialog } from './Onboarding'
import { Artwork, Backdrop, Button, cx, IconButton, IconTile, Kbd, Logo, Menu, MenuItem, SectionTitle, Spinner, TitleCover, Toast } from './ui'
import { themeFor, usePalette } from './palette'
import { getPrefs, usePrefs } from './prefs'
import { sessionTime, useNowPlaying } from './nowPlaying'
import { appName, matchPlaying } from '../electron/parse'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function App() {
  const [library, setLibrary] = useState<Song[]>([])
  const [current, setCurrent] = useState<Song | null>(null)
  const [candidates, setCandidates] = useState<LyricsMatch[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [libFilter, setLibFilter] = useState<LibFilter>('all')
  const search = useRef<HTMLInputElement>(null)
  // The sidebar folds away in small windows; the choice is remembered.
  const [sideOpen, setSideOpen] = useState(() => { try { const v = localStorage.getItem('sidebar'); return v ? v === 'open' : window.innerWidth >= 900 } catch { return window.innerWidth >= 900 } })
  const toggleSide = useCallback((open?: boolean) => setSideOpen((o) => { const n = open ?? !o; try { localStorage.setItem('sidebar', n ? 'open' : 'closed') } catch { /* per-viewer convenience only */ } return n }), [])
  const [dragging, setDragging] = useState(false)
  const [aiView, setAiView] = useState(false)
  const prefs = usePrefs()
  const [listening, setListening] = useState(getPrefs().startListening) // "Listening now": show lyrics for whatever is playing on this PC
  const [aiTrack, setAiTrack] = useState<Track | null>(null)
  const [align, setAlign] = useState<string | null>(null) // lyrics to sync, when the AI screen was opened for that
  const [sort, setSort] = useState<'recent' | 'title' | 'artist'>(() => { try { return (localStorage.getItem('sort') as 'title') || 'recent' } catch { return 'recent' } })
  const [queue, setQueue] = useState<QueueStatus>({ running: false, phase: 'idle', done: 0, total: 0, errors: 0 })
  const [importing, setImporting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [sortMenu, setSortMenu] = useState(false)
  const [libLoaded, setLibLoaded] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(loadProfile)
  const [editProfile, setEditProfile] = useState(false)
  const [providers, setProviders] = useState<Providers | null>(null) // set while Settings is open
  const [syncPage, setSyncPage] = useState(false) // the Sync lyrics tab: pick an audio file + its lyrics
  const flash = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 3000) }, [])
  const dirty = useRef(false)
  const onDirty = useCallback((d: boolean) => { dirty.current = d }, [])
  // Every navigation goes through this so unsaved editor changes are never silently dropped.
  const leave = () => {
    if (dirty.current && !confirm('You have unsaved lyric edits. Leave without saving?')) return false
    dirty.current = false
    return true
  }

  useEffect(() => { api.list().then(setLibrary).catch((e) => setError(msg(e))).finally(() => setLibLoaded(true)) }, [])
  useEffect(() => { api.queueStatus().then(setQueue).catch(() => {}); return api.onQueue(setQueue) }, [])
  // Background work (imports, queued or finished analyses) changes the library; refresh, and the open song unless it has unsaved edits.
  useEffect(() => api.onLibraryChanged(() => {
    api.list().then((l) => { setLibrary(l); if (!dirty.current) setCurrent((c) => (c ? l.find((x) => x.id === c.id) ?? c : c)) }).catch(() => {})
  }), [])
  useEffect(() => { try { localStorage.setItem('sort', sort) } catch { /* per-viewer convenience only */ } }, [sort])
  // Shrinking the window below a usable width folds the sidebar (without changing the saved choice).
  useEffect(() => {
    let wasWide = window.innerWidth >= 760
    const r = () => { const wide = window.innerWidth >= 760; if (wasWide && !wide) setSideOpen(false); wasWide = wide }
    window.addEventListener('resize', r)
    return () => window.removeEventListener('resize', r)
  }, [])
  // Ctrl+K or Ctrl+F jumps to library search; Ctrl+B shows or hides the sidebar.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || document.querySelector('[aria-modal="true"]')) return
      const key = e.key.toLowerCase()
      if (key === 'k' || (key === 'f' && !e.shiftKey)) { e.preventDefault(); setSideOpen(true); setTimeout(() => { search.current?.focus(); search.current?.select() }, 0) }
      else if (key === 'b') { e.preventDefault(); toggleSide() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [toggleSide])

  const saved = !!current && library.some((s) => s.id === current.id)

  async function pickAiFile(getTrack: () => Promise<Track | null>) {
    setError(null)
    try { const t = await getTrack(); if (t) setAiTrack(t) } catch (e) { setError(msg(e)) }
  }

  const aiDone = useCallback(async (ai: AiLyrics) => {
    if (!aiTrack) return
    const existing = (current?.filePath === aiTrack.filePath ? current : null) ?? library.find((s) => s.filePath && s.filePath === aiTrack.filePath)
    const song: Song = { ...(existing ?? { ...aiTrack, id: crypto.randomUUID(), favorite: false, savedAt: 0 }), ai }
    if (existing && library.some((s) => s.id === existing.id)) {
      const u = await api.update(song.id, { ai })
      setLibrary((l) => l.map((s) => (s.id === u.id ? u : s)))
      setCurrent(u)
    } else setCurrent(song)
    setCandidates([])
    setAiView(false)
    setAlign(null)
  }, [aiTrack, current, library])

  async function saveAi(ai: AiLyrics) {
    const song = { ...current!, ai }
    if (saved) {
      const u = await api.update(song.id, { ai })
      setLibrary((l) => l.map((s) => (s.id === u.id ? u : s)))
      setCurrent(u)
    } else await save(song)
  }

  async function open(getTrack: () => Promise<Track | null>) {
    setError(null)
    setAiView(false)
        setCurrent(null)
    setBusy('Reading track…')
    try {
      const track = await getTrack()
      if (!track) return
      const existing = library.find((s) => (track.sourceUrl && s.sourceUrl === track.sourceUrl) || (track.filePath && s.filePath === track.filePath))
      if (existing) { setCurrent(existing); setCandidates([]); return }
      setBusy(`Finding lyrics for “${track.title}”…`)
      const { best, candidates } = await api.lyrics(track)
      let song = withLyrics({ ...track, id: crypto.randomUUID(), favorite: false, savedAt: 0 }, best)
      // A typed search has no metadata of its own, so adopt the matched song's.
      if (track.source === 'search' && best) song = { ...song, title: best.title, artist: best.artist, album: best.album, durationSec: best.durationSec }
      setCurrent(song)
      setCandidates(candidates)
    } catch (e) {
      setError(msg(e))
    } finally {
      setBusy(null)
    }
  }

  function submit(raw: string) {
    const s = raw.trim()
    if (!s) return
    if (detectInput(s)) return open(() => api.link(s))
    if (/^https?:\/\//i.test(s)) { setError('i only speak Spotify, SoundCloud and YouTube links 🤷 or just type “Artist - Title”'); return }
    const split = splitArtistTitle(s) ?? { artist: '', title: s }
    return open(async () => ({ ...split, source: 'search' as const }))
  }

  async function change(song: Song) {
    setCurrent(song)
    if (saved) {
      const u = await api.update(song.id, song)
      setLibrary((l) => l.map((s) => (s.id === u.id ? u : s)))
    } else if (song.favorite) await save(song)
  }

  async function save(song = current!) {
    try {
      const s = await api.save({ ...song, savedAt: Date.now() })
      setCurrent(s)
      setLibrary((l) => [s, ...l.filter((x) => x.id !== s.id)])
    } catch (e) { setError(msg(e)) }
  }

  async function remove() {
    if (!current || (prefs.confirmRemove && !confirm(`Remove “${current.title}” from your library?`))) return
    await api.remove(current.id)
    setLibrary((l) => l.filter((s) => s.id !== current.id))
    setCurrent({ ...current, favorite: false, savedAt: 0 })
  }

  async function research(title: string, artist: string) {
    if (!current) return
    setBusy('digging around…'); setError(null)
    try {
      const r = await api.lyrics({ title, artist, durationSec: current.durationSec })
      setCandidates(r.candidates)
    } catch (e) { setError(msg(e)) } finally { setBusy(null) }
  }

  async function exportLyrics(format: 'txt' | 'lrc') {
    try { await api.exportLyrics(current!, format) } catch (e) { setError(msg(e)) }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file && aiView) return pickAiFile(() => api.file(api.pathFor(file)))
    if (!leave()) return
    if (file) return open(() => api.file(api.pathFor(file)))
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (text) submit(text.split('\n')[0])
  }

  const q = filter.toLowerCase()
  const shown = library.filter((s) => FILTERS[libFilter].test(s) && (!q || `${s.title} ${s.artist} ${s.album ?? ''} ${s.plainLyrics ?? ''}`.toLowerCase().includes(q)))
  if (sort !== 'recent') shown.sort((a, b) => (sort === 'title' ? a.title : a.artist || '~').localeCompare(sort === 'title' ? b.title : b.artist || '~', undefined, { sensitivity: 'base' }))

  // ---- Listening now ----
  // The song to show: what's playing, else the last paused one. Sessions without an artist (browser tabs, ads) aren't songs.
  const sessions = useNowPlaying(true) // also drives the sidebar controller, so always on
  const live = sessions.find((x) => x.status === 'Playing' && x.title && x.artist) ?? sessions.find((x) => x.title && x.artist)
  const liveKey = live ? `${live.title}\n${live.artist}` : ''
  const shownKey = useRef('')
  const [listenRun, setListenRun] = useState(0) // bumps when the tab is clicked, so it re-checks what's playing
  useEffect(() => {
    if (!listening || !live || liveKey === shownKey.current || dirty.current) return // never replace unsaved edits
    shownKey.current = liveKey
    const inLibrary = library.find((x) => matchPlaying(x, [live]))
    if (inLibrary) { setCurrent(inLibrary); setCandidates([]); setAiView(false); setError(null); return }
    open(async () => ({ title: live.title, artist: live.artist, artwork: live.art, source: 'search' as const }))
  }, [listening, liveKey, listenRun]) // eslint-disable-line react-hooks/exhaustive-deps
  // Art can land a moment after the title: add it to the open song (if it isn't a saved one with its own).
  useEffect(() => {
    if (listening && live?.art && current && !current.artwork && !saved && matchPlaying(current, [live])) setCurrent({ ...current, artwork: live.art })
  }, [listening, live?.art, current?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const openListening = () => { if (!leave()) return; shownKey.current = ''; setListenRun((n) => n + 1); setListening(true); setCurrent(null); setAiView(false); setError(null) }

  const title = syncPage && !current ? 'Sync lyrics' : listening && !current ? 'Listening now' : aiView ? (align ? 'Sync lyrics' : 'AI Reconstruction') : busy && !current ? 'Loading' : current ? current.title : 'Home'
  // The window title (taskbar, Alt+Tab, screen readers) names what is open.
  useEffect(() => { document.title = title === 'Home' ? 'Verse' : `${title} · Verse` }, [title])
  const goHome = () => { if (!leave()) return; setListening(false); setCurrent(null); setAiView(false); setAlign(null); setError(null); setSyncPage(false) }
  const openSong = (s: Song) => { if (current?.id === s.id && !aiView && !listening) return; if (!leave()) return; setListening(false); setCurrent(s); setAiView(false); setCandidates([]); setError(null) }

  const openSync = () => { if (!leave()) return; setListening(false); setCurrent(null); setAiView(false); setError(null); setSyncPage(true) }
  const startSync = (t: Track, lyrics: string) => { setAiTrack({ ...t, plainLyrics: lyrics } as Track); setAlign(lyrics); setSyncPage(false); setAiView(true) }
  const openSettings = () => { api.aiProviders().then(setProviders).catch((e) => setError(msg(e))) }
  const openAi = () => { if (!leave()) return; setListening(false); setAiView(true); setAlign(null); setAiTrack(current?.filePath ? current : aiTrack); setError(null) }
  // Home's "needs lyrics" list: straight to the AI screen with that song loaded.
  const reconstruct = (s: Song) => { if (!leave()) return; setListening(false); setSyncPage(false); setCurrent(s); setCandidates([]); setAiTrack(s); setAlign(null); setAiView(true); setError(null) }

  // Colour comes from the music: the open song's artwork tints the window; Home gets the house aurora.
  const artSrc = !prefs.tint ? undefined : aiView ? aiTrack?.artwork : current && !busy ? current.artwork : undefined
  const theme = themeFor(usePalette(artSrc))
  const onMusic = aiView || (!!current && !busy)

  return (
    <div className="relative flex h-full flex-col overflow-hidden" onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={(e) => { if (!e.relatedTarget) setDragging(false) }} onDrop={onDrop}>
      <Backdrop theme={theme} src={artSrc} className={cx('bottom-auto', onMusic ? 'h-[640px]' : 'h-[600px] opacity-75')} />

      {/* Title bar: draggable; the native window buttons sit on a transparent overlay at the right (about 140px). */}
      <div className="drag relative z-10 flex h-11 shrink-0 items-center">
        <div className={cx('flex h-full shrink-0 items-center gap-2.5 pr-2 pl-4', sideOpen && 'w-[236px] border-r border-white/[0.06] bg-sidebar backdrop-blur-2xl min-[1100px]:w-[264px]')}>
          <Logo size={28} />
          <span className="font-serif text-[22px] leading-none">Verse</span>
          <IconButton label={sideOpen ? 'Hide sidebar (Ctrl+B)' : 'Show sidebar (Ctrl+B)'} size="sm" onClick={() => toggleSide()} className="no-drag ml-auto">
            {sideOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </IconButton>
        </div>
        <div className="min-w-0 flex-1" aria-hidden />
        <div className="mr-[150px] flex items-center"><Updater /></div>
      </div>

      <div className={cx('relative grid min-h-0 flex-1', sideOpen ? 'grid-cols-[236px_minmax(0,1fr)] min-[1100px]:grid-cols-[264px_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)]')}>
        <aside className={cx('relative z-10 min-h-0 flex-col border-r border-white/[0.06] bg-sidebar backdrop-blur-2xl', sideOpen ? 'flex' : 'hidden')} aria-label="Sidebar">
          <nav className="space-y-0.5 px-3 pt-2" aria-label="Main">
            <NavItem icon={<Home size={17} />} active={!current && !aiView && !busy && !listening && !syncPage} onClick={goHome}>Home</NavItem>
            <NavItem icon={<Headphones size={17} />} active={listening} onClick={openListening}>
              <span className="flex-1 text-left">Listening now</span>
              {live?.status === 'Playing' && <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-ok"><span className="size-1.5 rounded-full bg-ok" aria-hidden />Live</span>}
            </NavItem>
            <NavItem icon={<Sparkles size={17} />} active={aiView && !align} onClick={openAi}>AI Reconstruction</NavItem>
            <NavItem icon={<FileText size={17} />} active={(syncPage && !current && !aiView && !busy) || (aiView && !!align)} onClick={openSync}>Sync lyrics</NavItem>
          </nav>

          <div className="mt-7 flex h-7 items-center justify-between pr-2 pl-5">
            <span className="t-eyebrow flex items-center gap-2">Library{library.length > 0 && <span className="tabular rounded-full bg-white/[0.08] px-1.5 py-px text-[10px] font-medium tracking-normal text-muted">{library.length}</span>}</span>
            <span className="flex items-center">
              <div className="relative">
                <IconButton label="Sort" size="sm" onClick={() => setSortMenu(!sortMenu)}><ArrowDownUp size={14} /></IconButton>
                {sortMenu && (
                  <Menu onClose={() => setSortMenu(false)} align="right" width="w-44">
                    {([['recent', 'Recently added'], ['title', 'Title'], ['artist', 'Artist']] as const).map(([k, l]) => (
                      <MenuItem key={k} icon={sort === k ? <Check size={14} className="text-accent" /> : <span className="inline-block w-3.5" />} onClick={() => { setSort(k); setSortMenu(false) }}>{l}</MenuItem>
                    ))}
                  </Menu>
                )}
              </div>
              <LibraryMenu onImport={() => setImporting(true)} onToast={flash} />
            </span>
          </div>
          <div className="relative mx-3 mt-2">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 text-subtle" />
            <input ref={search} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search library" aria-label="Search library by title, artist or lyrics (Ctrl+K)"
              onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter('') } else if (e.key === 'Enter' && shown[0]) openSong(shown[0]) }}
              className="field peer pr-14 pl-9" />
            {filter
              ? <IconButton label="Clear search" size="sm" onClick={() => { setFilter(''); search.current?.focus() }} className="absolute top-1/2 right-1 -translate-y-1/2"><X size={13} /></IconButton>
              : <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 peer-focus:hidden"><Kbd>Ctrl K</Kbd></span>}
          </div>
          <div className="mx-3 mt-2.5 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label="Show">
            {(Object.keys(FILTERS) as LibFilter[]).map((k) => {
              const n = library.filter(FILTERS[k].test).length
              if (k !== 'all' && !n && libFilter !== k) return null
              return (
                <button key={k} onClick={() => setLibFilter(k)} aria-pressed={libFilter === k}
                  className={cx('h-8 shrink-0 rounded-full border px-3 text-[12px] font-medium whitespace-nowrap', libFilter === k ? 'border-fg bg-fg text-bg' : 'border-white/[0.12] text-muted hover:text-fg')}>
                  {FILTERS[k].label}{k !== 'all' && <span className="tabular ml-1.5 opacity-60">{n}</span>}
                </button>
              )
            })}
          </div>

          <ul className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="Songs">
            {!libLoaded && Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="flex h-[54px] items-center gap-3 px-2" aria-hidden>
                <div className="skeleton size-10 rounded-[7px]" /><div className="flex-1 space-y-2"><div className="skeleton h-2.5 w-3/4 rounded-full" /><div className="skeleton h-2 w-1/2 rounded-full" /></div>
              </li>
            ))}
            {shown.map((s) => {
              const active = current?.id === s.id && !aiView
              return (
                <li key={s.id}>
                  <button onClick={() => openSong(s)} aria-current={active ? 'true' : undefined}
                    className={cx('group flex h-[54px] w-full items-center gap-3 rounded-[11px] px-2 text-left', active ? 'bg-white/[0.1] shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]' : 'hover:bg-white/[0.05]')}>
                    <Artwork src={s.artwork} title={s.title} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className={cx('block truncate text-[13.5px] leading-tight', active ? 'font-semibold text-fg' : 'font-medium text-fg/90')}>{s.title}</span>
                      <span className="mt-1 block truncate text-[12px] leading-tight text-muted">{s.artist || 'Unknown artist'}</span>
                    </span>
                    {s.ai && <span className="shrink-0 rounded-full border border-accent/40 px-1.5 text-[10.5px] font-semibold text-accent" title="Lyrics written by AI">AI</span>}
                    {!s.ai && !s.plainLyrics && !s.syncedLyrics && <span className="shrink-0 text-[11px] text-subtle" aria-label="No lyrics yet">–</span>}
                    {s.favorite && <Heart size={13} className="shrink-0 fill-[#ff8a5c] text-[#ff8a5c]" aria-label="Favourite" />}
                  </button>
                </li>
              )
            })}
            {libLoaded && !shown.length && (
              <li className="px-4 py-10 text-center">
                {library.length
                  ? <><div className="text-[13px] font-medium text-fg/85">nope, nothing matches 🫠</div>{(filter || libFilter !== 'all') && <button className="mt-1.5 text-[12px] font-medium text-accent hover:underline" onClick={() => { setFilter(''); setLibFilter('all') }}>Show all songs</button>}</>
                  : <><div className="text-[13px] font-medium text-fg/85">it's empty in here 🦗</div><p className="mt-1 text-[12px] leading-relaxed text-subtle">save some songs and they'll hang out here.</p>
                    <button className="mt-2 text-[12px] font-medium text-accent hover:underline" onClick={() => setImporting(true)}>Import a music folder</button></>}
              </li>
            )}
          </ul>
          <QueueCard status={queue} />
          {/* Profile and Settings share the footer, so the nav only holds places to go. */}
          <div className="mx-3 mb-3 flex items-center gap-1 border-t border-white/[0.06] pt-3">
            {profile ? (
              <button onClick={() => setEditProfile(true)} className="flex min-w-0 flex-1 items-center gap-3 rounded-[12px] px-2 py-1.5 text-left hover:bg-white/[0.05]" aria-label="Edit profile">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-[13px] font-semibold text-accent-fg" aria-hidden>{profile.name.trim()[0]?.toUpperCase() || '?'}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{profile.name || 'You'}</span>
                  <span className="block text-[11.5px] text-muted">Profile</span>
                </span>
              </button>
            ) : <span className="flex-1" />}
            <IconButton label="Settings" size="lg" tipPos="up left" onClick={openSettings}><Settings size={17} /></IconButton>
          </div>
        </aside>

        <main className="relative flex min-h-0 flex-col overflow-hidden">
          {error && (
            <div role="alert" className="pop relative z-10 mx-6 mt-4 flex items-start gap-3 rounded-[14px] border border-bad/30 bg-[rgb(58_14_20/0.6)] px-4 py-3 text-[13px] text-[#ffc4c4] shadow-[var(--shadow-float)] backdrop-blur-xl min-[1000px]:mx-10">
              <AlertCircle size={16} className="mt-px shrink-0 text-bad" /><span className="flex-1 leading-relaxed">{error}</span>
              <IconButton label="Dismiss" size="sm" onClick={() => setError(null)} className="-my-1 text-[#ffc4c4] hover:text-white"><X size={14} /></IconButton>
            </div>
          )}
          {aiView ? (
            <div className="relative min-h-0 flex-1 px-6 pt-8 min-[1000px]:px-10"><Analysis track={aiTrack} align={align} onPick={() => pickAiFile(api.pick)} onDone={aiDone} /></div>
          ) : busy && !current ? (
            <LoadingSong message={busy} />
          ) : current ? (
            <div className="relative min-h-0 flex-1 px-6 pt-8 min-[1000px]:px-10">
              <SongView key={current.id} song={current} saved={saved} theme={theme} candidates={candidates} searching={busy === 'Searching…'}
                onChange={change} onSave={() => save()} onRemove={remove} onResearch={research} onExport={exportLyrics}
                onAnalyse={() => { if (!leave()) return; setAiTrack(current); setAlign(null); setAiView(true) }} onSaveAi={saveAi} onDirty={onDirty}
                onSyncAI={(lyrics) => { if (!leave()) return; setAiTrack({ ...current, plainLyrics: lyrics } as Track); setAlign(lyrics); setAiView(true) }} />
            </div>
          ) : listening ? (
            <ListeningEmpty />
          ) : syncPage ? (
            <SyncLyrics onStart={startSync} onError={setError} />
          ) : (
            <HomePage library={library} live={live} onListen={openListening} onSubmit={submit} onBrowse={() => open(api.pick)} onOpen={openSong} onImport={() => setImporting(true)} onAi={openAi} name={profile?.name}
              onSync={openSync} onReconstruct={reconstruct} onAnalyseAll={() => { analyseMissingSongs(flash).catch((e) => flash(msg(e))) }} />
          )}
          {dragging && (
            <div className="fade pointer-events-none absolute inset-4 z-20 grid place-items-center rounded-[22px] border-2 border-dashed border-accent/45 bg-[rgb(5_5_7/0.72)] backdrop-blur-xl">
              <div className="pop flex flex-col items-center gap-3 text-center">
                <IconTile size={56}><FileAudio size={26} /></IconTile>
                <span className="text-[17px] font-semibold tracking-tight">Drop to open</span>
                <span className="text-[13px] text-muted">MP3, FLAC, WAV, M4A, OGG and more</span>
              </div>
            </div>
          )}
        </main>
      </div>
      {live && prefs.nowPlayingBar && <NowPlayingBar live={live} onOpen={openListening} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onToast={flash} />}
      {toast && <Toast>{toast}</Toast>}
      {!profile && <Onboarding onDone={setProfile} />}
      {editProfile && profile && <ProfileDialog profile={profile} library={library} onSave={setProfile} onClose={() => setEditProfile(false)} />}
      {providers && <AiSettings providers={providers} onChange={setProviders} onClose={() => setProviders(null)} onEditProfile={profile ? () => { setProviders(null); setEditProfile(true) } : undefined} />}
    </div>
  )
}

type LibFilter = 'all' | 'favourites' | 'noLyrics' | 'ai' | 'local'
const FILTERS: Record<LibFilter, { label: string; test: (s: Song) => boolean }> = {
  all: { label: 'All', test: () => true },
  favourites: { label: 'Favourites', test: (s) => s.favorite },
  noLyrics: { label: 'No lyrics', test: (s) => !s.ai && !s.plainLyrics && !s.syncedLyrics && !s.instrumental },
  ai: { label: 'AI lyrics', test: (s) => !!s.ai },
  local: { label: 'Local files', test: (s) => !!s.filePath },
}

function NavItem({ icon, active, onClick, children }: { icon: ReactNode; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-current={active ? 'page' : undefined}
      className={cx('flex h-11 w-full items-center gap-3 rounded-[12px] px-3.5 text-[13.5px]', active ? 'bg-white/[0.1] font-semibold text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]' : 'font-medium text-white/65 hover:bg-white/[0.05] hover:text-fg')}>
      <span className={active ? 'text-accent' : 'text-white/45'}>{icon}</span>{children}
    </button>
  )
}

// Controls the music app that's playing (same as the keyboard media keys). Verse itself plays nothing.
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function NowPlayingBar({ live, onOpen }: { live: Playing; onOpen: () => void }) {
  const playing = live.status === 'Playing'
  const ctl = (a: 'toggle' | 'next' | 'prev') => { api.nowPlayingControl(live.app, a).catch(() => {}) }
  const [, tick] = useState(0)
  useEffect(() => { if (!playing) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t) }, [playing])
  const at = Math.min(sessionTime(live), live.end || Infinity)
  return (
    <section className="relative z-20 grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 border-t border-line bg-bg-raised px-4 py-2.5 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]" aria-label={`Now playing in ${appName(live.app)}`}>
      <button onClick={onOpen} className="flex min-w-0 items-center gap-3 rounded-[10px] p-1 text-left hover:bg-white/[0.05]" data-tip="Show lyrics" data-tip-pos="up">
        {live.art ? <Artwork src={live.art} size={44} /> : <Artwork title={live.title} size={44} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium">{live.title}</span>
          <span className="block truncate text-[12px] text-muted">{live.artist} · {appName(live.app)}</span>
        </span>
      </button>
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-2">
          <IconButton label="Previous" tipPos="up" onClick={() => ctl('prev')}><SkipBack size={16} fill="currentColor" /></IconButton>
          <button onClick={() => ctl('toggle')} aria-label={playing ? 'Pause' : 'Play'} className="btn-play size-10">
            {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} className="ml-0.5" fill="currentColor" />}
          </button>
          <IconButton label="Next" tipPos="up" onClick={() => ctl('next')}><SkipForward size={16} fill="currentColor" /></IconButton>
        </div>
        {live.end > 0 && (
          <div className="tabular hidden w-full max-w-[520px] items-center gap-2.5 text-[11.5px] text-muted min-[900px]:flex">
            <span>{clock(at)}</span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.14]" role="progressbar" aria-label="Song position" aria-valuemin={0} aria-valuemax={Math.round(live.end)} aria-valuenow={Math.round(at)}>
              <span className="block h-full rounded-full bg-accent" style={{ width: `${(at / live.end) * 100}%` }} />
            </span>
            <span>{clock(live.end)}</span>
          </div>
        )}
      </div>
      <div className="hidden justify-end min-[900px]:flex">
        <Button variant="ghost" icon={<AudioLines size={15} />} onClick={onOpen}>Lyrics</Button>
      </div>
    </section>
  )
}

function ListeningEmpty() {
  return (
    <div className="enter relative grid min-h-0 flex-1 place-items-center px-6 pb-16">
      <div className="flex max-w-md flex-col items-center text-center">
        <IconTile tone="mint" size={60}><Headphones size={27} /></IconTile>
        <h1 className="t-title mt-6">it's quiet... too quiet 🤫</h1>
        <p className="mt-2.5 text-[14px] leading-relaxed text-muted">Play a song in Spotify, Apple Music, or any music app on this PC. Verse finds the lyrics and keeps them in time, and switches when the song changes.</p>
        <p className="breathe mt-6 flex items-center gap-2 text-[12px] font-medium text-subtle"><span className="size-1.5 rounded-full bg-ok" aria-hidden />Listening for music…</p>
      </div>
    </div>
  )
}

function LoadingSong({ message }: { message: string }) {
  return (
    <div className="fade relative px-6 pt-8 min-[1000px]:px-10" aria-busy="true">
      <div className="flex items-end gap-8">
        <div className="skeleton size-[200px] shrink-0 rounded-[14px]" />
        <div className="flex-1 space-y-4 pb-2"><div className="skeleton h-2.5 w-24 rounded-full" /><div className="skeleton h-10 w-3/5 rounded-full" /><div className="skeleton h-4 w-1/4 rounded-full" /><div className="flex gap-2.5 pt-2"><div className="skeleton h-10 w-32 rounded-full" /><div className="skeleton size-10 rounded-full" /></div></div>
      </div>
      <div className="mt-12 flex items-center gap-2.5 text-[13px] font-medium text-muted" role="status"><Spinner size={15} className="text-accent" />{message}</div>
      <div className="mt-6 max-w-2xl space-y-5">{[88, 72, 80, 60, 84, 66].map((w, i) => <div key={i} className="skeleton h-6 rounded-full" style={{ width: `${w}%` }} />)}</div>
    </div>
  )
}

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening' }

function HomePage({ library, live, onListen, onSubmit, onBrowse, onOpen, onImport, onAi, onSync, onReconstruct, onAnalyseAll, name }: {
  library: Song[]; live?: Playing; name?: string; onListen: () => void; onSubmit: (s: string) => void; onBrowse: () => void; onOpen: (s: Song) => void; onImport: () => void; onAi: () => void
  onSync: () => void; onReconstruct: (s: Song) => void; onAnalyseAll: () => void
}) {
  const [value, setValue] = useState('')
  const input = detectInput(value)
  const link = input && (input.kind === 'spotify' ? 'Spotify' : input.kind === 'soundcloud' ? 'SoundCloud' : input.music ? 'YouTube Music' : 'YouTube')
  const analysed = library.filter((s) => s.ai).sort((a, b) => b.ai!.createdAt - a.ai!.createdAt).slice(0, 12)
  const added = library.filter((s) => !analysed.includes(s)).slice(0, 12)
  const missing = library.filter((s) => s.filePath && FILTERS.noLyrics.test(s)) // only files can be reconstructed
  return (
    <div className="@container relative min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1120px] px-6 pt-10 pb-20 min-[1000px]:px-10">
        <header className="enter">
          <p className="text-[14px] text-muted">{greeting()}{name?.trim() && `, ${name.trim()}`}</p>
          <h1 className="t-title mt-1.5">What are we singing <em className="text-accent">today?</em></h1>
        </header>

        <form className="enter mt-6 group flex h-16 items-center gap-3 rounded-[20px] border border-white/[0.12] bg-bg-raised pr-2 pl-5 focus-within:border-accent/50 focus-within:shadow-[0_0_0_3px_rgb(255_207_58/0.12)]"
          onSubmit={(e) => { e.preventDefault(); onSubmit(value) }}>
          <Search size={20} className="shrink-0 text-accent" />
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label="Song name or link"
            placeholder="Search a song, or paste a Spotify, SoundCloud or YouTube link"
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-subtle" />
          {link && (
            <span className="pop flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-ok/[0.12] px-2.5 text-[12px] font-semibold text-ok">
              <Check size={13} strokeWidth={2.5} aria-hidden />{link} link
            </span>
          )}
          <Button type="submit" variant="primary" size="lg" className="!h-12 !rounded-[14px] !px-6" disabled={!value.trim()}>Get lyrics</Button>
        </form>
        <p className="enter mt-2.5 px-1.5 text-[12.5px] text-subtle">Type “Artist - Title”, paste a link, or drop an audio file anywhere in the window.</p>

        {live && (
          <section className="enter-2 card mt-10 flex flex-wrap items-center gap-8 !rounded-[28px] p-8" aria-label={`Playing in ${appName(live.app)}`}>
            <Artwork src={live.art} title={live.title} size={120} />
            <div className="min-w-[240px] flex-1">
              <p className="flex items-center gap-2 text-[13px] text-muted">
                <span className={cx('size-2 rounded-full', live.status === 'Playing' ? 'bg-ok' : 'bg-subtle')} aria-hidden />
                {live.status === 'Playing' ? 'Playing' : 'Paused'} in {appName(live.app)}
              </p>
              <p className="t-title mt-2 truncate">{live.title}</p>
              <p className="mt-1 truncate text-[15px] text-muted">{live.artist}</p>
              <Button variant="primary" size="lg" className="mt-4 !rounded-[10px]" icon={<AudioLines size={16} />} onClick={onListen}>Show live lyrics</Button>
            </div>
          </section>
        )}

        {missing.length > 0 && (
          <section className="enter-3 mt-12" aria-labelledby="missing-h">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="missing-h" className="text-[22px] font-semibold tracking-[-0.025em]">{missing.length === 1 ? '1 song still needs lyrics' : `${missing.length} songs still need lyrics`}</h2>
                <p className="mt-1 text-[13px] text-muted">None were found online. AI can listen and write them out, timed to every word.</p>
              </div>
              {missing.length > 1 && <Button icon={<Sparkles size={15} />} onClick={onAnalyseAll}>Reconstruct all</Button>}
            </div>
            <ul className="grid gap-3 @min-[720px]:grid-cols-2 @min-[1000px]:grid-cols-3">
              {missing.slice(0, 6).map((s) => (
                <li key={s.id} className="card flex items-center gap-3 p-3">
                  <button onClick={() => onOpen(s)} className="flex min-w-0 flex-1 items-center gap-3 rounded-[12px] text-left" aria-label={`Open ${s.title}`}>
                    <Artwork src={s.artwork} title={s.title} size={48} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold">{s.title}</span>
                      <span className="block truncate text-[12.5px] text-muted">{s.artist || 'Unknown artist'}</span>
                    </span>
                  </button>
                  <Button className="!rounded-[12px] !bg-accent-soft !text-accent !shadow-none" onClick={() => onReconstruct(s)}>Reconstruct</Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="More ways to get lyrics" className="enter-3 mt-12 flex flex-wrap gap-2.5">
          <WayIn icon={<FileAudio size={16} />} onClick={onBrowse}>Open an audio file</WayIn>
          <WayIn icon={<Sparkles size={16} />} onClick={onAi}>Write lyrics with AI</WayIn>
          <WayIn icon={<FolderInput size={16} />} onClick={onImport}>Import a music folder</WayIn>
          <WayIn icon={<FileText size={16} />} onClick={onSync}>Time my own lyrics</WayIn>
        </section>

        {analysed.length > 0 && <Shelf title="Recently analysed" sub="Lyrics reconstructed by AI" songs={analysed} onOpen={onOpen} />}
        {added.length > 0 && <Shelf title={analysed.length ? 'Recently added' : 'Your library'} songs={added} onOpen={onOpen} />}
        {!library.length && (
          <section className="enter-3 mt-16">
            <SectionTitle sub="Three ways to perfectly timed lyrics.">How Verse works</SectionTitle>
            <ol className="grid gap-3 @min-[720px]:grid-cols-3">
              {[
                ['01', 'Search', 'Type a song or paste a link. Verse finds published, time-synced lyrics in seconds.'],
                ['02', 'Reconstruct', 'Nothing online? AI isolates the vocals, writes down what is sung and times every word.'],
                ['03', 'Sing', 'Karaoke lights up each word as it is sung, and can mute the original vocals.'],
              ].map(([n, t, d]) => (
                <li key={n} className="card p-5">
                  <div className="t-shine tabular text-[28px] leading-none font-semibold tracking-[-0.04em]">{n}</div>
                  <div className="mt-4 text-[15px] font-semibold tracking-tight">{t}</div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{d}</p>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  )
}

function WayIn({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="card card-hover flex h-12 items-center gap-2.5 !rounded-[14px] px-4 text-[13.5px] font-medium">
      <span className="text-accent" aria-hidden>{icon}</span>{children}
    </button>
  )
}

function Shelf({ title, sub, songs, onOpen }: { title: string; sub?: string; songs: Song[]; onOpen: (s: Song) => void }) {
  return (
    <section className="enter-3 mt-14">
      <SectionTitle sub={sub}>{title}</SectionTitle>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-5 gap-y-7">
        {songs.map((s) => (
          <li key={s.id}>
            <button onClick={() => onOpen(s)} className="group w-full rounded-[14px] text-left" aria-label={`${s.title} by ${s.artist || 'unknown artist'}`}>
              <div className="relative aspect-square w-full overflow-hidden rounded-[14px] bg-white/[0.05] transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
                {s.artwork ? <img src={s.artwork} alt="" draggable={false} className="size-full object-cover" /> : <TitleCover title={s.title} size={150} />}
                <span className="pointer-events-none absolute inset-0 rounded-[14px] ring-1 ring-inset ring-white/[0.08]" aria-hidden />
                {s.ai && <span className="absolute top-2 left-2 rounded-full bg-[#12110f]/85 px-2 py-0.5 text-[10.5px] font-semibold text-accent">AI lyrics</span>}
                <span className="absolute right-2.5 bottom-2.5 grid size-10 translate-y-2 place-items-center rounded-full bg-white text-black opacity-0 shadow-[0_8px_20px_-6px_rgb(0_0_0/0.8)] transition duration-300 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
                  <Play size={15} className="ml-0.5" fill="currentColor" />
                </span>
              </div>
              <div className="mt-3 truncate text-[13.5px] font-medium">{s.title}</div>
              <div className="mt-0.5 truncate text-[12.5px] text-muted">{s.artist || 'Unknown artist'}</div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

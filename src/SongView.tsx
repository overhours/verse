import { useEffect, useState } from 'react'
import { AlertCircle, Check, Copy, Download, ExternalLink, FileAudio, FileUp, FolderOpen, Hand, Heart, MicVocal, MoreHorizontal, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'
import { lrcToPlain, parseLrc, toLrcText } from '../electron/parse'
import { fromLyrics } from '../electron/timed'
import { AiLyrics, api, fmtTime, LyricsMatch, Song, withLyrics } from './api'
import Editor from './ai/Editor'
import EmbedDialog from './EmbedDialog'
import Karaoke, { karaokeLines } from './Karaoke'
import LyricsImport from './LyricsImport'
import Lyrics from './Lyrics'
import { Artwork, Button, cx, IconButton, IconTile, Menu, MenuItem, MenuLabel, Spinner, Toast } from './ui'
import type { Theme } from './palette'

const SOURCE = { spotify: 'Spotify', soundcloud: 'SoundCloud', youtube: 'YouTube', file: 'Local file', search: 'Search' } as const

interface Props {
  song: Song
  saved: boolean
  theme: Theme
  candidates: LyricsMatch[]
  searching: boolean
  onChange: (s: Song) => void
  onSave: () => void
  onRemove: () => void
  onResearch: (title: string, artist: string) => void
  onExport: (format: 'txt' | 'lrc') => void
  onAnalyse: () => void
  onSaveAi: (ai: AiLyrics) => Promise<void>
  onDirty: (d: boolean) => void
  onSyncAI: (lyrics: string) => void
}

export default function SongView({ song, saved, theme, candidates, searching, onChange, onSave, onRemove, onResearch, onExport, onAnalyse, onSaveAi, onDirty, onSyncAI }: Props) {
  const noLyrics = !song.plainLyrics && !song.syncedLyrics && !song.instrumental
  const [manual, setManual] = useState<AiLyrics | null>(null)
  const [tapStart, setTapStart] = useState(false)
  // Timing the user just imported or started editing takes precedence over the saved AI timing.
  const ai = manual ?? song.ai ?? undefined
  const [importing, setImporting] = useState(false)
  const [embedding, setEmbedding] = useState(false)
  const [tab, setTab] = useState<'online' | 'ai'>(song.ai ? 'ai' : 'online')
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [fixing, setFixing] = useState(noLyrics && !song.ai)
  const [karaoke, setKaraoke] = useState(false)
  const [menu, setMenu] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const showAi = tab === 'ai' && !!ai
  useEffect(() => { if (showAi && song.filePath && !peaks) api.aiWaveform(song.filePath).then(setPeaks).catch(() => setPeaks([])) }, [showAi, song.filePath, peaks])
  const [title, setTitle] = useState(song.title)
  const [artist, setArtist] = useState(song.artist)
  const text = song.plainLyrics || (song.syncedLyrics ? lrcToPlain(song.syncedLyrics) : '')
  const withAi = { ...song, ai }
  const canKaraoke = !!song.audioUrl && karaokeLines(withAi).length > 0
  const canTimeMyself = !!song.audioUrl && !!song.durationSec && !song.ai && !!text

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2600) }
  const act = (fn: () => unknown) => () => { setMenu(false); fn() }
  const copy = async () => { await navigator.clipboard.writeText(`${song.title} — ${song.artist}\n\n${text}`); flash('Lyrics copied') }
  const timeMyself = () => {
    const src = song.syncedLyrics ? parseLrc(song.syncedLyrics).filter((l) => l.text).map((l) => ({ time: l.time, text: l.text }))
      : (song.plainLyrics ?? '').split(/\r?\n/).map((t) => ({ text: t }))
    setManual(fromLyrics(src, song.durationSec ?? 0, 'manual'))
    setTapStart(!song.syncedLyrics)
    setTab('ai')
  }
  const hasLyrics = !!(song.plainLyrics || song.syncedLyrics)
  // Imported lyrics become this song's lyrics. Nothing existing is replaced without asking.
  const importText = (t: string, timed?: { time: number; text: string }[]) => {
    if (hasLyrics && (song.plainLyrics ?? '').trim() !== t.trim() && !confirm(`Replace the current lyrics of “${song.title}” with the imported ones?`)) return false
    onChange({ ...song, plainLyrics: t, syncedLyrics: timed?.length ? toLrcText(timed) : undefined, lyricsId: undefined, instrumental: false })
    setFixing(false) // the song has lyrics now; the search panel would only crowd them
    return true
  }
  const replacesTiming = () => !(song.ai || manual) || confirm(`Replace the current timing of “${song.title}”? The new timing isn't saved until you press Save.`)
  const importOnly = (t: string, timed?: { time: number; text: string }[]) => { if (importText(t, timed)) { setImporting(false); setTab('online'); flash('Lyrics imported') } }
  const useTimestamps = (t: string, timed: { time: number; text: string }[]) => {
    if (!replacesTiming() || !importText(t, timed)) return
    setManual(fromLyrics(timed, song.durationSec ?? timed[timed.length - 1].time + 5, 'manual'))
    setTapStart(false); setTab('ai'); setImporting(false)
    flash('Timestamps imported. Fine-tune them, then save.')
  }
  const syncAI = (t: string) => {
    if (!(song.ai ? confirm(`Replace the current AI timing of “${song.title}” when the sync finishes?`) : true) || !importText(t)) return
    setImporting(false)
    onSyncAI(t)
  }
  const attachAudio = async () => {
    const t = await api.pick()
    if (t?.filePath) onChange({ ...song, filePath: t.filePath, audioUrl: t.audioUrl, durationSec: t.durationSec ?? song.durationSec })
  }

  const compact = showAi
  const aiIsReconstruction = !!ai && !/^(Manual|Line timestamps|Published synced)/.test(ai.providers.transcription) && !ai.providers.refinement?.startsWith('Your lyrics')
  const lyricsKind = song.ai ? (aiIsReconstruction ? 'AI lyrics' : 'Timed lyrics') : song.syncedLyrics ? 'Synced lyrics' : song.plainLyrics ? 'Lyrics' : song.instrumental ? 'Instrumental' : null
  const big = compact ? 'md' : 'lg'
  const heroArt = compact ? 'clamp(72px, 13cqw, 104px)' : 'clamp(136px, 24cqw, 232px)'
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <header className={cx('enter relative z-30 flex items-end', compact ? 'mb-5 gap-5' : 'mb-8 gap-8')}>
        <Artwork src={song.artwork} title={song.title} size={compact ? 104 : 232}
          style={{ width: heroArt, height: heroArt, boxShadow: `0 36px 72px -30px ${theme.glow}, 0 24px 48px -24px rgb(0 0 0 / 0.95)` }} />
        <div className="flex min-w-0 flex-1 flex-col pb-1">
          <span className="t-eyebrow flex flex-wrap items-center gap-x-2 gap-y-1">
            {SOURCE[song.source]}
            {lyricsKind && <><span aria-hidden className="text-white/25">·</span>{lyricsKind}</>}
            {saved && <><span aria-hidden className="text-white/25">·</span><span className="flex items-center gap-1 text-white/60"><Check size={12} strokeWidth={2.5} className="text-accent" />In library</span></>}
          </span>
          <h1 className={cx('selectable mt-2.5', compact ? 't-title truncate' : 't-display line-clamp-2 leading-[1.06]')}>{song.title}</h1>
          <p className={cx('selectable truncate font-medium', compact ? 'mt-1 text-[15px]' : 'mt-3 text-[19px] tracking-[-0.012em]')} style={{ color: theme.accent }}>
            {song.artist || 'Unknown artist'}
          </p>
          {(song.album || song.durationSec) && (
            <p className="selectable mt-1 truncate text-[13px] text-muted">
              {song.album}{song.album && song.durationSec ? <span className="text-white/25"> · </span> : null}{song.durationSec ? <span className="tabular">{fmtTime(song.durationSec)}</span> : null}
            </p>
          )}
          <div className={cx('flex flex-wrap items-center gap-2.5', compact ? 'mt-3.5' : 'mt-6')}>
            {canKaraoke && <Button variant="primary" size={big} icon={<MicVocal size={compact ? 15 : 17} />} onClick={() => setKaraoke(true)}>Karaoke</Button>}
            {!saved && <Button variant={canKaraoke ? 'secondary' : 'primary'} size={big} icon={<Plus size={compact ? 15 : 17} />} onClick={onSave}>Add to Library</Button>}
            {song.filePath && !song.ai && noLyrics && <Button size={big} icon={<Sparkles size={compact ? 15 : 16} />} onClick={onAnalyse}>Analyse with AI</Button>}
            {noLyrics && !song.ai && <Button size={big} icon={<FileUp size={compact ? 15 : 16} />} onClick={() => setImporting(true)} tip="From a .lrc or .txt file, Genius, or pasted text">Import lyrics</Button>}
            <IconButton label={song.favorite ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={song.favorite} variant="secondary" size={compact ? 'md' : 'lg'}
              onClick={() => onChange({ ...song, favorite: !song.favorite })} className={song.favorite ? '!text-accent' : ''}>
              <Heart size={compact ? 15 : 17} className={song.favorite ? 'fill-current' : ''} />
            </IconButton>
            <div className="relative">
              <IconButton label="More actions" variant="secondary" size={compact ? 'md' : 'lg'} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}><MoreHorizontal size={compact ? 16 : 18} /></IconButton>
              {menu && (
                <Menu onClose={() => setMenu(false)} width="w-64">
                  <MenuLabel>Lyrics</MenuLabel>
                  {song.filePath && !(noLyrics && !song.ai) && <MenuItem icon={<Sparkles size={14} />} onClick={act(onAnalyse)}>{song.ai ? 'Re-analyse with AI' : 'Analyse with AI'}</MenuItem>}
                  {!(noLyrics && !song.ai) && <MenuItem icon={<FileUp size={14} />} onClick={act(() => setImporting(true))}>Import lyrics…</MenuItem>}
                  {canTimeMyself && <MenuItem icon={<Hand size={14} />} onClick={act(timeMyself)}>{song.syncedLyrics ? 'Edit word timing' : 'Time lyrics by tapping'}</MenuItem>}
                  {!showAi && <MenuItem icon={<Search size={14} />} onClick={act(() => setFixing(!fixing))}>{noLyrics ? 'Search again' : 'Wrong lyrics? Find others'}</MenuItem>}
                  {text && <MenuItem icon={<Copy size={14} />} onClick={act(copy)}>Copy lyrics</MenuItem>}
                  {(text || (song.filePath && ai)) && <MenuLabel>Export</MenuLabel>}
                  {text && <MenuItem icon={<Download size={14} />} onClick={act(() => onExport('txt'))}>Lyrics as .txt</MenuItem>}
                  {song.syncedLyrics && <MenuItem icon={<Download size={14} />} onClick={act(() => onExport('lrc'))}>Lyrics as .lrc</MenuItem>}
                  {song.filePath && (ai || text) && <MenuItem icon={<FileAudio size={14} />} onClick={act(() => setEmbedding(true))}>Embed lyrics into audio…</MenuItem>}
                  {(song.filePath || song.sourceUrl) && <MenuLabel>File</MenuLabel>}
                  {song.filePath && <MenuItem icon={<FolderOpen size={14} />} onClick={act(() => api.showInFolder(song.filePath!))}>Show file location</MenuItem>}
                  {song.sourceUrl && (
                    <a href={song.sourceUrl} target="_blank" rel="noreferrer" role="menuitem" onClick={() => setMenu(false)}
                      className="flex h-[34px] items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] hover:bg-white/[0.09] focus-visible:bg-white/[0.09]"><ExternalLink size={14} className="text-muted" />Open in {SOURCE[song.source]}</a>
                  )}
                  {saved && <><div className="mx-1.5 my-1.5 h-px bg-white/[0.08]" /><MenuItem icon={<Trash2 size={14} />} onClick={act(onRemove)}>Remove from library</MenuItem></>}
                </Menu>
              )}
            </div>
          </div>
        </div>
      </header>

      {ai && (
        <div className="segmented enter-2 mb-5 self-start" role="tablist" aria-label="Lyrics source">
          {([['ai', aiIsReconstruction ? 'AI reconstruction' : 'Timing editor'], ['online', 'Published lyrics']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="h-8 px-4 text-[13px]">{l}</button>
          ))}
        </div>
      )}
      {karaoke && <Karaoke song={withAi} onClose={() => setKaraoke(false)} />}
      {importing && <LyricsImport song={song} onClose={() => setImporting(false)} onImportText={importOnly} onUseTimestamps={useTimestamps} onSyncAI={syncAI} onAttachAudio={attachAudio} />}
      {embedding && <EmbedDialog song={withAi} onClose={() => setEmbedding(false)} />}
      {toast && <Toast>{toast}</Toast>}

      {showAi ? <Editor key={ai!.createdAt} song={song} ai={ai!} peaks={peaks} onSave={async (a) => { await onSaveAi(a); setManual(null) }} onDirty={onDirty} startTap={tapStart}
        startDirty={!!manual} onEmbed={song.filePath ? () => setEmbedding(true) : undefined} /> : <>
      {fixing && (
        <section className="card pop mb-6 p-5" aria-label="Find different lyrics">
          <div className="mb-4 flex items-center gap-3">
            <IconTile tone="ocean" size={34}><Search size={16} /></IconTile>
            <div className="flex-1">
              <div className="text-[14px] font-semibold tracking-tight">Find different lyrics</div>
              <div className="text-[12px] text-muted">Search LRCLIB, lyrics.ovh and Genius (with a token) by title and artist, then pick the right version.</div>
            </div>
            <IconButton label="Close" size="sm" variant="secondary" className="self-start" onClick={() => setFixing(false)}><X size={15} /></IconButton>
          </div>
          <form className="flex flex-wrap gap-2.5" onSubmit={(e) => { e.preventDefault(); onResearch(title, artist) }}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" className="field min-w-48 flex-1" />
            <input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Artist" aria-label="Artist" className="field min-w-40 flex-1" />
            <Button variant="primary" className="h-9 px-4" icon={searching ? <Spinner size={14} className="text-accent-fg" /> : <Search size={14} />} disabled={searching || !title.trim()}>{searching ? 'Searching…' : 'Search'}</Button>
          </form>
          {candidates.length > 0 ? (<>
            <ul className="mt-4 max-h-64 space-y-0.5 overflow-y-auto border-t border-white/[0.07] pt-3">
              {candidates.map((m) => (
                <li key={m.id}>
                  <button onClick={() => onChange(withLyrics(song, m))} aria-current={m.id === song.lyricsId ? 'true' : undefined}
                    className={cx('flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[13px]', m.id === song.lyricsId ? 'bg-accent-soft' : 'hover:bg-white/[0.06]')}>
                    {m.id === song.lyricsId ? <Check size={14} strokeWidth={2.5} className="shrink-0 text-accent" /> : <span className="w-3.5 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate"><span className="font-medium">{m.title}</span><span className="text-muted"> · {m.artist}{m.album ? ` · ${m.album}` : ''}</span></span>
                    {m.durationSec ? <span className="tabular text-muted">{fmtTime(m.durationSec)}</span> : null}
                    {m.source && <span className="text-[11px] text-muted">{m.source}</span>}
                    <span className={cx('rounded-full px-2 py-0.5 text-[10.5px] font-medium', m.syncedLyrics ? 'bg-accent-soft text-accent' : 'bg-white/[0.06] text-muted')}>{m.instrumental ? 'Instrumental' : m.syncedLyrics ? 'Synced' : 'Plain'}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 flex gap-2 text-[12px] text-muted"><AlertCircle size={14} className="mt-px shrink-0" />Lyrics found online aren't always 100% accurate. A match may be a different song or version, so check them before saving.</p>
          </>) : !searching && <p className="mt-4 text-[13px] text-muted">nothing. nada. zero. 💀 try the song's original title or just the main artist</p>}
        </section>
      )}

      <Lyrics key={`${song.id}:${song.lyricsId}`} song={song} />
      </>}
    </div>
  )
}

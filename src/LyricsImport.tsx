import { useEffect, useState } from 'react'
import { AlertCircle, ExternalLink, FileAudio, FileText, KeyRound, Search, Sparkles } from 'lucide-react'
import { lrcToPlain, parseLrc } from '../electron/parse'
import { lrcTime } from '../electron/timed'
import AiSettings from './ai/AiSettings'
import { api, GeniusHit, Providers, Song } from './api'
import { Artwork, Button, cx, Modal, Segmented, Spinner, IconTile } from './ui'

type Timed = { time: number; text: string }[]
interface Candidate { text: string; timed?: Timed; from: string }

interface Props {
  song: Song
  onClose: () => void
  onImportText: (text: string, timed?: Timed) => void
  onUseTimestamps: (text: string, timed: Timed) => void
  onSyncAI: (text: string) => void
  onAttachAudio: () => Promise<void>
}

export default function LyricsImport({ song, onClose, onImportText, onUseTimestamps, onSyncAI, onAttachAudio }: Props) {
  const [tab, setTab] = useState<'file' | 'genius' | 'paste'>('file')
  const [cand, setCand] = useState<Candidate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const hasAudio = !!song.filePath

  const pickFile = async () => {
    setError(null)
    try {
      const f = await api.openLyricsFile()
      if (f) setCand({ text: f.text, timed: f.timed, from: f.name })
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <Modal title="Import lyrics" labelId="import-lyrics-title" onClose={onClose} width="max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <Segmented label="Lyrics source" value={tab} onChange={(t) => { setTab(t); setError(null) }}
          items={[['file', 'From file'], ['genius', 'Search Genius'], ['paste', 'Paste']]} />
        <span className="truncate text-[12px] text-subtle">Into: <span className="text-muted">{song.title}</span></span>
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          {tab === 'file' && (
            <div className="flex h-full min-h-56 flex-col items-center justify-center gap-4 rounded-[18px] border-2 border-dashed border-white/[0.12] bg-white/[0.02] p-6 text-center">
              <IconTile tone="ocean" size={44}><FileText size={20} /></IconTile>
              <div>
                <div className="text-[14px] font-semibold tracking-tight">Choose a lyrics file</div>
                <p className="mt-1 text-[12px] leading-relaxed text-muted"><b className="font-medium text-fg/80">.lrc</b> keeps its timestamps, or can be re-timed by AI. <b className="font-medium text-fg/80">.txt</b> is plain text that AI times to the audio.</p>
              </div>
              <Button variant="primary" onClick={pickFile}>Choose .lrc or .txt…</Button>
            </div>
          )}
          {tab === 'genius' && <GeniusSearch song={song} onFound={(c) => { setCand(c); setError(null) }} onError={setError} />}
          {tab === 'paste' && <Paste onChange={(t) => setCand(t.trim() ? { text: t, from: 'Pasted text' } : null)} />}
          {error && <p role="alert" className="mt-3 flex gap-2 rounded-[12px] bg-bad/[0.08] px-3 py-2 text-[12px] text-bad"><AlertCircle size={14} className="mt-px shrink-0" />{error}</p>}
        </div>
        <Preview cand={cand} />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2.5 border-t border-white/[0.08] pt-5">
        <div className="mr-auto flex min-w-0 items-center gap-2 text-[12px] text-muted">
          <FileAudio size={14} className="shrink-0" />
          {hasAudio ? <span className="truncate">Audio: {song.filePath!.split(/[\\/]/).pop()}</span> : (
            <>this song has no audio file 🙈 <Button size="sm" variant="ghost" className="-ml-1 text-accent hover:text-accent"
              onClick={async () => { setBusy(true); try { await onAttachAudio() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>Choose audio file…</Button></>
          )}
        </div>
        {busy && <Spinner size={14} />}
        {cand && (
          <>
            <Button variant="secondary" onClick={() => onImportText(cand.text, cand.timed)}>Import text only</Button>
            {cand.timed && cand.timed.length > 0 && <Button variant={hasAudio ? 'secondary' : 'primary'} onClick={() => onUseTimestamps(cand.text, cand.timed!)}>Use these timestamps</Button>}
            {hasAudio && (
              <Button variant="primary" icon={<Sparkles size={14} />} onClick={() => onSyncAI(cand.text)}
                tip="Listens to the song and times every line and word to the vocals">{cand.timed ? 'Retime with AI' : 'Sync with AI'}</Button>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function Preview({ cand }: { cand: Candidate | null }) {
  if (!cand) return (
    <div className="grid min-h-56 place-items-center rounded-[18px] border border-white/[0.07] bg-black/20 p-6 text-center text-[12px] leading-relaxed text-subtle">
      The lyrics preview appears here before anything is imported.
    </div>
  )
  const rows = cand.timed?.length ? cand.timed.map((l) => ({ t: l.time, text: l.text })) : cand.text.split('\n').map((text) => ({ t: undefined, text }))
  const count = rows.filter((r) => r.text.trim() && !/^\s*[[(].*[\])]\s*$/.test(r.text)).length
  return (
    <div className="pop flex min-h-56 min-w-0 flex-col overflow-hidden rounded-[18px] border border-white/[0.08] bg-black/20">
      <div className="flex items-baseline justify-between gap-2 border-b border-white/[0.07] bg-white/[0.03] px-4 py-2.5 text-[12px]">
        <span className="truncate font-semibold">{cand.from}</span>
        <span className="tabular shrink-0 text-subtle">{count} lines · {cand.timed?.length ? 'timed' : 'untimed'}</span>
      </div>
      <div className="selectable max-h-72 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed">
        {rows.map((r, i) => /^\s*[[(].*[\])]\s*$/.test(r.text)
          ? <div key={i} className="mt-2 text-[11px] font-medium tracking-wide text-subtle uppercase first:mt-0">{r.text.replace(/[[\]()]/g, '')}</div>
          : !r.text.trim() ? <div key={i} className="h-2.5" />
          : <div key={i} className="flex gap-3">{r.t !== undefined && <span className="tabular w-14 shrink-0 font-mono text-[11px] leading-[22px] text-subtle">{lrcTime(r.t)}</span>}<span>{r.text}</span></div>)}
      </div>
    </div>
  )
}

function Paste({ onChange }: { onChange: (t: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-muted">Paste lyrics you have the right to use. Section labels like [Chorus] are kept.</span>
      <textarea onChange={(e) => onChange(e.target.value)} spellCheck={false} placeholder={'[Verse 1]\nFirst line\nSecond line'}
        className="field h-56 resize-none p-3 leading-relaxed" />
    </label>
  )
}

function GeniusSearch({ song, onFound, onError }: { song: Song; onFound: (c: Candidate) => void; onError: (m: string | null) => void }) {
  const [title, setTitle] = useState(song.title)
  const [artist, setArtist] = useState(song.artist)
  const [providers, setProviders] = useState<Providers | null>(null)
  const [settings, setSettings] = useState(false)
  const [hits, setHits] = useState<GeniusHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<GeniusHit | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'found' | 'missing'>('idle')
  useEffect(() => { api.aiProviders().then(setProviders).catch(() => {}) }, [])
  const hasToken = !!providers?.keys.genius

  const search = async () => {
    onError(null); setSearching(true); setPicked(null); setState('idle')
    try { setHits(await api.geniusSearch(`${title} ${artist}`.trim())) } catch (e) { onError((e as Error).message); setHits(null) } finally { setSearching(false) }
  }
  const pick = async (h: GeniusHit) => {
    setPicked(h); setState('loading'); onError(null)
    try {
      const [{ best }, gText] = await Promise.all([api.lyrics({ title: h.title, artist: h.artist }), api.geniusLyrics(h.id).catch(() => null)])
      // LRCLIB's synced lyrics win because they carry timestamps; otherwise Genius's own text.
      if (best?.syncedLyrics || !gText) {
        if (!best || (!best.plainLyrics && !best.syncedLyrics)) { setState('missing'); return }
        const timed = best.syncedLyrics ? parseLrc(best.syncedLyrics).filter((l) => l.text) : undefined
        onFound({ text: best.plainLyrics || lrcToPlain(best.syncedLyrics!), timed: timed?.length ? timed : undefined, from: `${h.title} · ${h.artist} (lyrics from ${best.source ?? 'LRCLIB'})` })
      } else onFound({ text: gText, from: `${h.title} · ${h.artist} (lyrics from Genius)` })
      setState('found')
    } catch (e) { onError((e as Error).message); setState('idle') }
  }

  if (providers && !hasToken) {
    return (
      <div className="card p-5 text-[12px] leading-relaxed text-muted">
        <div className="mb-3 flex items-center gap-3"><IconTile tone="amber" size={34}><KeyRound size={16} /></IconTile><div className="text-[14px] font-semibold tracking-tight text-fg">Connect Genius</div></div>
        Genius search needs a free API token: create an API client at genius.com/api-clients and paste its Client Access Token.
        With it, Verse can also show Genius lyrics in search results.
        <div className="mt-4"><Button variant="primary" icon={<KeyRound size={14} />} onClick={() => setSettings(true)}>Add Genius token</Button></div>
        {settings && <AiSettings providers={providers} onChange={setProviders} onClose={() => setSettings(false)} />}
      </div>
    )
  }
  return (
    <div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); search() }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Song title" aria-label="Song title" className="field min-w-0 flex-1" />
        <input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Artist" aria-label="Artist" className="field min-w-0 flex-1" />
        <Button variant="primary" className="h-9 px-4" disabled={searching || !(title.trim() || artist.trim())} icon={searching ? <Spinner size={13} className="text-accent-fg" /> : <Search size={14} />}>Search</Button>
      </form>
      <ul className="mt-3 max-h-60 space-y-0.5 overflow-y-auto" aria-label="Genius results">
        {hits?.length === 0 && <li className="py-6 text-center text-[12px] text-subtle">Genius came up empty 💀 try fewer words.</li>}
        {hits?.map((h) => (
          <li key={h.id}>
            <button onClick={() => pick(h)} aria-current={picked?.id === h.id ? 'true' : undefined}
              className={cx('flex w-full items-center gap-3 rounded-[12px] px-2 py-1.5 text-left', picked?.id === h.id ? 'bg-accent-soft' : 'hover:bg-white/[0.06]')}>
              <Artwork src={h.art} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{h.title}</span>
                <span className="block truncate text-[12px] text-muted">{h.artist}{h.year ? ` · ${h.year}` : ''}</span>
              </span>
              {picked?.id === h.id && state === 'loading' && <Spinner size={14} />}
            </button>
          </li>
        ))}
      </ul>
      {picked && state === 'found' && (
        <p className="mt-3 flex gap-2 text-[12px] text-muted"><AlertCircle size={14} className="mt-px shrink-0" />Lyrics found online aren't always 100% accurate. They may be for a different song or version, so check the preview before importing.</p>
      )}
      {picked && state === 'missing' && (
        <div className="pop mt-3 rounded-[14px] border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-[12px] leading-relaxed text-muted">
          Neither Genius nor LRCLIB returned lyrics for “{picked.title}”. You can read them on Genius and paste them in the Paste tab.
          <a href={picked.url} target="_blank" rel="noreferrer" className="mt-1.5 flex w-fit items-center gap-1 text-accent hover:underline">Open on Genius <ExternalLink size={12} /></a>
        </div>
      )}
    </div>
  )
}

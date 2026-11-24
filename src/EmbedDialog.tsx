import { useState } from 'react'
import { AlertTriangle, Check, FileAudio, FolderOpen } from 'lucide-react'
import { lrcToPlain, parseLrc } from '../electron/parse'
import { lineText, lrcTime } from '../electron/timed'
import { api, Song } from './api'
import { Button, Modal, Segmented, Spinner, IconTile } from './ui'

type Which = 'ai' | 'synced' | 'plain'

const FORMAT: Record<string, { ok: boolean; synced: boolean; note: string }> = {
  mp3: { ok: true, synced: true, note: 'Written as ID3v2 USLT (lyrics) and SYLT (synchronised lyrics) frames. Title, artist, album, track number and artwork are kept.' },
  flac: { ok: true, synced: true, note: 'Written to the LYRICS Vorbis comment as LRC text, the convention players such as foobar2000, MusicBee and Poweramp read as synced lyrics. Other tags and artwork are kept.' },
  ogg: { ok: true, synced: true, note: 'Written to the LYRICS Vorbis comment as LRC text, which players that support synced lyrics read. Other tags are kept.' },
  opus: { ok: true, synced: true, note: 'Written to the LYRICS Vorbis comment as LRC text, which players that support synced lyrics read. Other tags are kept.' },
  m4a: { ok: true, synced: false, note: 'M4A has no standard timed-lyrics tag. The lyrics go in the ©lyr atom as LRC text: Apple Music shows them as plain lyrics, and some other players read the timestamps. Other tags and artwork are kept.' },
}

export default function EmbedDialog({ song, onClose }: { song: Song; onClose: () => void }) {
  const ext = song.filePath!.split('.').pop()!.toLowerCase()
  const fmt = FORMAT[ext]
  const options: [Which, string][] = [
    ...(song.ai ? [['ai', /^(Manual|Line timestamps)/.test(song.ai.providers.transcription) ? 'Your timing' : 'AI timing'] as [Which, string]] : []),
    ...(song.syncedLyrics ? [['synced', 'Published synced'] as [Which, string]] : []),
    ...(song.plainLyrics || song.syncedLyrics ? [['plain', 'Plain text'] as [Which, string]] : []),
  ]
  const [which, setWhich] = useState<Which>(options[0]?.[0] ?? 'plain')
  const [sidecar, setSidecar] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ path: string; synced: boolean; sidecar?: string } | null>(null)
  const timed = which !== 'plain'

  const rows: { t?: number; text: string }[] = which === 'ai' && song.ai
    ? song.ai.lines.filter((l) => l.kind === 'vocal').map((l) => ({ t: l.start, text: lineText(l) }))
    : which === 'synced' && song.syncedLyrics ? parseLrc(song.syncedLyrics).filter((l) => l.text).map((l) => ({ t: l.time, text: l.text }))
    : (song.plainLyrics || (song.syncedLyrics ? lrcToPlain(song.syncedLyrics) : '')).split('\n').map((text) => ({ text }))

  const run = async () => {
    setBusy(true); setError(null)
    try { const r = await api.embedExport(song, which, sidecar && timed); if (r) setDone(r) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal title="Embed lyrics into audio" labelId="embed-title" onClose={onClose} width="max-w-2xl">
      {done ? (
        <div className="rise py-2">
          <div className="flex items-start gap-3">
            <IconTile tone="mint" size={40}><Check size={19} strokeWidth={2.75} /></IconTile>
            <div className="min-w-0">
              <div className="text-[15px] font-semibold tracking-tight">Exported with {done.synced ? 'synchronised' : 'plain'} lyrics</div>
              <p className="mt-1 text-[12px] break-all text-muted">{done.path}</p>
              {done.sidecar && <p className="text-[12px] break-all text-subtle">+ {done.sidecar.split(/[\\/]/).pop()}</p>}
              <p className="mt-2 text-[12px] text-subtle">Your original file was not changed.</p>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2.5">
            <Button variant="secondary" icon={<FolderOpen size={14} />} onClick={() => api.showInFolder(done.path)}>Show in folder</Button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3.5 rounded-[16px] border border-white/[0.08] bg-white/[0.04] px-4 py-3">
            <IconTile size={36}><FileAudio size={17} /></IconTile>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold">{song.filePath!.split(/[\\/]/).pop()}</div>
              <div className="text-[12px] text-subtle">{ext.toUpperCase()} · a new copy is created; the original stays untouched</div>
            </div>
          </div>

          {!fmt ? (
            <p className="mt-4 flex gap-2 text-[13px] leading-relaxed text-muted">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
              {ext.toUpperCase()} files have no metadata field for lyrics, so they can't be embedded. Export a .lrc file instead and keep it next to the song: most players pick it up automatically.
            </p>
          ) : (
            <>
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="text-[12px] font-medium text-muted">Lyrics to embed</span>
                {options.length > 1 && <Segmented size="sm" label="Lyrics to embed" value={which} onChange={setWhich} items={options} />}
              </div>
              <div className="selectable mt-2.5 max-h-44 overflow-y-auto rounded-[14px] border border-white/[0.07] bg-black/25 px-4 py-3 text-[13px] leading-relaxed">
                {rows.slice(0, 200).map((r, i) => r.text.trim()
                  ? <div key={i} className="flex gap-3">{r.t !== undefined && <span className="tabular w-14 shrink-0 font-mono text-[11px] leading-[22px] text-subtle">{lrcTime(r.t)}</span>}<span>{r.text}</span></div>
                  : <div key={i} className="h-2" />)}
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-muted">{timed && !fmt.synced ? <><span className="text-warn">Timing limitation: </span>{fmt.note}</> : fmt.note}</p>
              {timed && (
                <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-[13px] text-muted">
                  <input type="checkbox" className="check" checked={sidecar} onChange={(e) => setSidecar(e.target.checked)} />
                  Also save a .lrc file next to the exported copy
                </label>
              )}
            </>
          )}
          {error && <p role="alert" className="mt-3 text-[12px] text-bad">{error}</p>}
          <div className="mt-6 flex justify-end gap-2.5 border-t border-white/[0.08] pt-5">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            {fmt ? (
              <Button variant="primary" onClick={run} disabled={busy || !options.length} icon={busy ? <Spinner size={14} className="text-accent-fg" /> : undefined}>{busy ? 'Exporting…' : 'Embed & Export…'}</Button>
            ) : (
              <Button variant="primary" disabled={!timed} onClick={async () => { try { await api.exportLyrics(song, which === 'ai' ? 'ai-lrc' : 'lrc') } catch (e) { setError((e as Error).message) } }}>Export .lrc…</Button>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

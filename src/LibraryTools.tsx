import { useEffect, useState } from 'react'
import { ArchiveRestore, Download, FolderInput, MoreHorizontal, Sparkles, Square, X } from 'lucide-react'
import { AnalyzeOptions, api, Providers, QueueStatus } from './api'
import { Button, IconButton, Menu, MenuItem, Modal, SwitchRow } from './ui'

// Background jobs use the same settings as the AI screen, limited to providers that are actually set up.
export function queueOpts(av: Providers['available']): AnalyzeOptions | null {
  let saved: Partial<AnalyzeOptions> = {}
  try { saved = JSON.parse(localStorage.getItem('ai-opts') ?? '{}') } catch { /* defaults */ }
  const has = (t: AnalyzeOptions['transcriber']) => (t === 'local' ? av.local : t === 'openai' ? av.openai : av.whisperx)
  const transcriber = saved.transcriber && has(saved.transcriber) ? saved.transcriber : (['local', 'whisperx', 'openai'] as const).find(has)
  if (!transcriber) return null
  return { transcriber, separate: (saved.separate ?? true) && av.separation, refine: saved.refine ?? true, diarize: false, language: saved.language ?? '', useReference: saved.useReference ?? true }
}

// Queues every song without lyrics for AI analysis (Library menu and Home's "Reconstruct all").
export async function analyseMissingSongs(onToast: (m: string) => void) {
  const opts = queueOpts((await api.aiProviders()).available)
  if (!opts) { onToast('Set up the free engine or an AI provider on the AI screen first.'); return }
  if (!confirm('Analyse every song in your library that has no lyrics, one after another in the background?\n\nOnly continue if you own these files or have permission to analyse them.')) return
  const n = await api.analyseMissing(opts)
  onToast(n ? `Analysing ${n} song${n === 1 ? '' : 's'} in the background` : 'Every song already has lyrics')
}

export function LibraryMenu({ onImport, onToast }: { onImport: () => void; onToast: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  const act = (fn: () => Promise<void> | void) => async () => { setOpen(false); try { await fn() } catch (e) { onToast((e as Error).message) } }
  const analyseMissing = () => analyseMissingSongs(onToast)
  return (
    <div className="relative">
      <IconButton label="Library actions" size="sm" tipLeft aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}><MoreHorizontal size={15} /></IconButton>
      {open && (
        <Menu onClose={() => setOpen(false)} align="right" width="w-64">
          <MenuItem icon={<FolderInput size={14} />} onClick={act(onImport)}>Import a music folder…</MenuItem>
          <MenuItem icon={<Sparkles size={14} />} onClick={act(analyseMissing)}>Analyse songs missing lyrics</MenuItem>
          <div className="mx-1.5 my-1.5 h-px bg-white/[0.08]" />
          <MenuItem icon={<Download size={14} />} onClick={act(async () => { if (await api.backupLibrary()) onToast('Library backed up') })}>Back up library…</MenuItem>
          <MenuItem icon={<ArchiveRestore size={14} />} onClick={act(async () => {
            const r = await api.restoreLibrary()
            if (r) onToast(`Restored ${r.added} song${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already in your library)` : ''}`)
          })}>Restore from backup…</MenuItem>
        </Menu>
      )}
    </div>
  )
}

export function ImportDialog({ onClose, onToast }: { onClose: () => void; onToast: (m: string) => void }) {
  const [providers, setProviders] = useState<Providers | null>(null)
  const [lyrics, setLyrics] = useState(true)
  const [analyse, setAnalyse] = useState(true)
  const [consent, setConsent] = useState(false)
  useEffect(() => { api.aiProviders().then(setProviders).catch(() => {}) }, [])
  const opts = providers ? queueOpts(providers.available) : null
  const wantsAi = analyse && !!opts
  const start = async () => {
    try {
      const r = await api.queueImport({ lyrics, analyse: wantsAi ? opts : null })
      if (!r) return
      onToast(r.found ? `Importing ${r.found} new song${r.found === 1 ? '' : 's'} in the background` : 'no new audio files in there 👀')
      onClose()
    } catch (e) { onToast((e as Error).message) }
  }
  return (
    <Modal title="Import a music folder" labelId="import-title" onClose={onClose}>
      <p className="text-[13px] leading-relaxed text-muted">Adds every audio file in the folder and its subfolders. Songs already in your library are skipped. Importing runs in the background, so you can keep using Verse.</p>
      <div className="inset-list mt-5">
        <SwitchRow className="px-4" label="Find lyrics online" help="Looks each song up on LRCLIB using its tags or file name." checked={lyrics} onChange={setLyrics} />
        <SwitchRow className="px-4" label="Analyse songs without lyrics" checked={wantsAi} disabled={!opts} onChange={setAnalyse}
          help={opts ? `Uses ${opts.transcriber === 'local' ? 'the free engine on this PC' : 'your AI provider'}, one song at a time. A few minutes per song.` : 'Set up the free engine or an AI provider on the AI screen first.'} />
      </div>
      {wantsAi && (
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[13px] text-muted">
          <input type="checkbox" className="check mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          I own these files or have permission to analyse them.
        </label>
      )}
      <div className="mt-6 flex justify-end gap-2.5">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={<FolderInput size={14} />} onClick={start} disabled={wantsAi && !consent}>Choose folder…</Button>
      </div>
    </Modal>
  )
}

export function QueueCard({ status }: { status: QueueStatus }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (status.running) { setShow(true); return }
    if (!status.summary) return
    setShow(true)
    const t = setTimeout(() => setShow(false), 8000)
    return () => clearTimeout(t)
  }, [status.running, status.summary])
  if (!show) return null
  const label = status.phase === 'import' ? 'Importing' : 'Analysing'
  return (
    <div className="glass pop mx-3 mb-3 rounded-[16px] px-4 py-3.5 text-[12px]" role="status" aria-live="polite">
      {status.running ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-semibold text-fg"><span className="breathe size-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" aria-hidden />{label} <span className="tabular font-medium text-muted">{Math.min(status.done + 1, status.total)} / {status.total}</span></span>
            <IconButton label="Cancel" size="sm" tipPos="up left" onClick={() => api.queueCancel()} className="-mr-1.5 size-6 hover:text-bad"><Square size={10} fill="currentColor" /></IconButton>
          </div>
          <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${(status.done / Math.max(1, status.total)) * 100}%` }} />
          </div>
          {status.current && <div className="mt-2 truncate text-muted">{status.current}</div>}
          {status.phase === 'analyse' && status.message && <div className="truncate text-subtle">{status.message}</div>}
        </>
      ) : (
        <div className="flex items-start justify-between gap-2"><span className="leading-relaxed text-muted">{status.summary}</span>
          <IconButton label="Dismiss" size="sm" tipPos="up left" onClick={() => setShow(false)} className="-mt-1 -mr-1.5 size-6"><X size={12} /></IconButton></div>
      )}
    </div>
  )
}

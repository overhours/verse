import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, AudioLines, Check, Clock3, Cpu, Download, FileAudio, KeyRound, Loader2, Minus, RotateCcw, Sparkles, Square } from 'lucide-react'
import { lrcToPlain } from '../../electron/parse'
import { STAGES } from '../../electron/timed'
import { AiLyrics, AnalyzeOptions, api, fmtTime, JobEvent, Providers, StageId, Track } from '../api'
import AiSettings from './AiSettings'
import Waveform from './Waveform'
import { Artwork, Button, cx, IconButton, IconTile, Segmented, Select, Spinner, SwitchRow } from '../ui'
import { themeFor, usePalette } from '../palette'

const LABEL: Record<StageId, string> = {
  prepare: 'Analysing audio and vocal sections', analyse: 'Transcribing the lead vocal', backing: 'Detecting backing vocals and ad-libs',
  sync: 'Aligning word timestamps', refine: 'Correcting against the audio', confidence: 'Scoring confidence', finalise: 'Validating the lyrics',
}
const LANGS: [string, string][] = [['', 'Detect automatically'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['pl', 'Polish'], ['ru', 'Russian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese']]

type StageState = { state: JobEvent['state'] | 'pending'; fraction?: number; message?: string }
const fresh = () => Object.fromEntries(STAGES.map((s) => [s, { state: 'pending' }])) as Record<StageId, StageState>

const loadOpts = (): Partial<AnalyzeOptions> => { try { return JSON.parse(localStorage.getItem('ai-opts') ?? '{}') } catch { return {} } }

export default function Analysis({ track, align, onPick, onDone }: { track: Track | null; align?: string | null; onPick: () => void; onDone: (ai: AiLyrics) => void }) {
  const label = (st: StageId) => (align && st === 'sync' ? 'Matching your lyrics to the vocals' : LABEL[st])
  const alignLines = align ? align.split('\n').filter((l) => l.trim() && !/^\s*[[(].*[\])]\s*$/.test(l)) : []
  const [providers, setProviders] = useState<Providers | null>(null)
  const [settings, setSettings] = useState(false)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [opts, setOpts] = useState<AnalyzeOptions>({ transcriber: 'whisperx', separate: true, refine: true, diarize: false, language: '', useReference: true, ...loadOpts() })
  const [consent, setConsent] = useState(false)
  const [phase, setPhase] = useState<'setup' | 'running' | 'error'>('setup')
  const [stages, setStages] = useState(fresh)
  const [log, setLog] = useState<{ t: number; text: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const job = useRef<string | null>(null)
  const theme = themeFor(usePalette(track?.artwork))
  const started = useRef(0)

  useEffect(() => { api.aiProviders().then(setProviders).catch((e) => setError(e.message)) }, [])
  useEffect(() => {
    setPeaks(null); setPhase('setup'); setError(null); setNotice(null); setStages(fresh()); setLog([])
    if (track?.filePath) api.aiWaveform(track.filePath).then(setPeaks).catch(() => setPeaks([]))
  }, [track?.filePath])
  useEffect(() => { try { localStorage.setItem('ai-opts', JSON.stringify({ ...opts, language: opts.language })) } catch { /* storage unavailable */ } }, [opts])

  // Fall back to whatever providers are actually configured.
  const av = providers?.available
  const has = (t: AnalyzeOptions['transcriber']) => !!av?.[t === 'whisperx' ? 'whisperx' : t]
  const transcriber = has(opts.transcriber) ? opts.transcriber : (['whisperx', 'local', 'openai'] as const).find(has) ?? opts.transcriber
  const effective: AnalyzeOptions = av ? {
    ...opts,
    transcriber,
    separate: opts.separate && av.separation,
    model: opts.model === 'large' && av.localLarge ? 'large' : 'turbo',
    refine: opts.refine,
    diarize: opts.diarize && av.diarize && transcriber === 'whisperx',
  } : opts
  const song = track as (Track & { plainLyrics?: string; syncedLyrics?: string }) | null
  const canRun = !!av && (av.whisperx || av.openai || av.local)

  useEffect(() => api.onAi((_, e) => {
    if (e.jobId !== job.current) return
    setStages((s) => ({ ...s, [e.stage]: { state: e.state, fraction: e.fraction, message: e.message ?? s[e.stage].message } }))
    if (e.message) setLog((l) => (l[l.length - 1]?.text === e.message ? l : [...l.slice(-40), { t: Date.now() - started.current, text: e.message! }]))
  }, (d) => {
    if (d.jobId !== job.current) return
    job.current = null
    if (d.ok) onDone(d.data)
    else if (d.cancelled) { setPhase('setup'); setNotice('Analysis cancelled. Anything already processed is cached, so running again is faster.') }
    else {
      setError(d.message); setPhase('error')
      setStages((s) => { const r = STAGES.find((k) => s[k].state === 'running'); return r ? { ...s, [r]: { ...s[r], state: 'pending', message: d.message } } : s })
    }
  }), [onDone])

  useEffect(() => {
    if (phase !== 'running') return
    const i = setInterval(() => setElapsed(Date.now() - started.current), 500)
    return () => clearInterval(i)
  }, [phase])

  const start = async () => {
    if (!track?.filePath) return
    setError(null); setNotice(null); setStages(fresh()); setLog([]); setPhase('running'); started.current = Date.now(); setElapsed(0)
    const reference = song?.plainLyrics || (song?.syncedLyrics ? lrcToPlain(song.syncedLyrics) : undefined)
    try { job.current = await api.aiStart(track.filePath, { ...effective, title: track.title, artist: track.artist, reference, ...(align ? { align, refine: false, useReference: false, diarize: false } : {}) }) }
    catch (e) { setError((e as Error).message); setPhase('error') }
  }
  const cancel = () => { if (job.current) api.aiCancel(job.current) }

  if (!track) {
    return (
      <div className="@container mx-auto h-full max-w-[1120px] overflow-y-auto pt-6 pb-16">
        <header className="enter">
          <p className="t-eyebrow">AI Reconstruction</p>
          <h1 className="t-display mt-3"><span className="t-shine">Hear every word.</span><br /><span className="text-white/40">Even when no one wrote it down.</span></h1>
          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-muted">Verse isolates the vocals, writes down exactly what is sung and times every word, even when no lyrics exist online. You can review and correct everything afterwards.</p>
        </header>
        <button onClick={onPick} className="enter-2 group mt-9 flex w-full flex-col items-center rounded-[24px] border-2 border-dashed border-white/[0.12] bg-white/[0.02] px-8 py-12 text-center transition-colors hover:border-accent/45 hover:bg-accent/[0.04]">
          <IconTile size={60}><FileAudio size={27} /></IconTile>
          <span className="mt-5 text-[18px] font-semibold tracking-[-0.02em]">Drop a song here, or choose a file</span>
          <span className="mt-1.5 text-[13px] text-muted">MP3, WAV, FLAC, M4A, OGG, Opus or AAC</span>
          <span className="btn btn-primary mt-6 h-10 px-6 text-[14px]">Choose a file…</span>
        </button>
        <ol className="enter-3 mt-10 grid gap-3 @min-[720px]:grid-cols-3">
          {([
            ['violet', <AudioLines key="i" size={18} />, 'Separate', 'The instrumental is removed, so only the voice is left to listen to.'],
            ['rose', <Sparkles key="i" size={18} />, 'Transcribe', 'Whisper listens to the vocals and writes down every word as it is sung.'],
            ['ocean', <Clock3 key="i" size={18} />, 'Synchronise', 'Each word is timed to the audio, double-checked, and scored for confidence.'],
          ] as const).map(([tone, icon, t, d], i) => (
            <li key={t} className="card p-5">
              <div className="flex items-center justify-between"><IconTile tone={tone} size={36}>{icon}</IconTile><span className="tabular text-[12px] font-semibold text-white/25">0{i + 1}</span></div>
              <div className="mt-4 text-[15px] font-semibold tracking-tight">{t}</div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{d}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-[12px] text-subtle">Only analyse audio you own or have permission to use. Results are AI-generated and can contain mistakes.</p>
      </div>
    )
  }

  const running = phase === 'running'
  const active = STAGES.find((s) => stages[s].state === 'running')
  const doneCount = STAGES.filter((s) => stages[s].state === 'done' || stages[s].state === 'skipped').length
  const overall = Math.min(1, (doneCount + (active && stages[active].fraction !== undefined ? stages[active].fraction! : 0)) / STAGES.length)

  return (
    <div className="@container mx-auto flex h-full w-full max-w-[1120px] min-h-0 flex-col overflow-y-auto pb-14">
      <header className="enter mb-6 flex items-end gap-6">
        <Artwork src={track.artwork} size={120} style={{ boxShadow: `0 30px 60px -26px ${theme.glow}, 0 18px 36px -18px rgb(0 0 0 / 0.9)` }} />
        <div className="min-w-0 flex-1 pb-1">
          <span className="t-eyebrow">{align ? 'Sync lyrics' : 'AI Reconstruction'}</span>
          <h1 className="t-title mt-2 truncate">{track.title}</h1>
          <p className="mt-1 truncate text-[15px] font-medium" style={{ color: theme.accent }}>{track.artist || 'Unknown artist'}{track.durationSec ? <span className="tabular font-normal text-muted"> · {fmtTime(track.durationSec)}</span> : ''}</p>
        </div>
        {!running && (
          <div className="flex shrink-0 items-center gap-2 pb-1">
            <Button variant="secondary" onClick={onPick}>Choose another file</Button>
            <IconButton label="AI providers & keys" variant="secondary" tipLeft onClick={() => setSettings(true)}><KeyRound size={15} /></IconButton>
          </div>
        )}
      </header>

      <div className="glass enter-2 rounded-[20px] p-3"><Waveform peaks={peaks} durationSec={track.durationSec ?? 0} scanning={running} height={76} /></div>
      {align && (
        <div className="card mt-4 flex items-start gap-3.5 p-4">
          <IconTile size={34}><Sparkles size={16} /></IconTile>
          <div className="min-w-0 text-[13px]">
            <div className="font-semibold"><span className="tabular">{alignLines.length}</span> lines of your lyrics will be timed to the vocals</div>
            <p className="mt-0.5 truncate text-[12px] text-muted">{alignLines.slice(0, 3).join(' / ')}{alignLines.length > 3 ? ' / …' : ''}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-subtle">Verse transcribes the song, then matches your words to what was sung. Your text and line order are kept; words it can't hear are flagged so you can check them.</p>
          </div>
        </div>
      )}

      {phase !== 'running' && (
        <section className="enter-3 mt-7" aria-label="Analysis options">
          {providers && av && (!av.local || !av.localSeparation) && <FreeEngine missingMB={Math.round(av.localMissingBytes / 1048576)} partial={av.local} onInstalled={setProviders} onPaid={() => setSettings(true)} />}
          {!providers && <div className="flex items-center gap-2.5 py-6 text-[13px] text-muted"><Spinner size={15} className="text-accent" />Checking available engines…</div>}
          {providers && canRun && (
            <div className="grid gap-x-6 gap-y-6 @min-[860px]:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
              <div>
                <h2 className="t-eyebrow mb-2.5 pl-1">Engine</h2>
                <div className="inset-list">
                  <div className="p-4">
                    <Select label="Transcription" value={effective.transcriber} onChange={(v) => setOpts({ ...opts, transcriber: v as AnalyzeOptions['transcriber'] })}>
                      <option value="local" disabled={!av?.local}>Free · Whisper on this PC{av?.local ? '' : ' (download first)'}</option>
                      <option value="whisperx" disabled={!av?.whisperx}>WhisperX large-v3 + forced alignment{av?.whisperx ? '' : ' (needs Replicate)'}</option>
                      <option value="openai" disabled={!av?.openai}>OpenAI Whisper{av?.openai ? '' : ' (needs OpenAI key)'}</option>
                    </Select>
                  </div>
                  {effective.transcriber === 'local' && <div className="p-4"><AccuracyPicker value={opts.model ?? 'turbo'} installed={!!av?.localLarge} onChange={(m) => setOpts({ ...opts, model: m })} onInstalled={setProviders} /></div>}
                  <div className="p-4">
                    <Select label="Language" value={opts.language} onChange={(v) => setOpts({ ...opts, language: v })}>
                      {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </Select>
                  </div>
                </div>
              </div>
              <div>
                <h2 className="t-eyebrow mb-2.5 pl-1">Processing</h2>
                <div className="inset-list">
                  <SwitchRow className="px-4" label="Isolate vocals first" checked={effective.separate} disabled={!av?.separation} onChange={(v) => setOpts({ ...opts, separate: v })}
                    help={!av?.separation ? 'Download the free engine or add a Replicate token.' : av?.whisperx
                      ? 'Demucs removes the instrumental before transcription. Much better on loud or electronic tracks.'
                      : 'Removes the instrumental on this PC first. Much better on loud tracks.'} />
                  {!align && <SwitchRow className="px-4" label="Check against published lyrics" checked={effective.useReference} onChange={(v) => setOpts({ ...opts, useReference: v })}
                    help="Compares with lyrics from your library or LRCLIB. Differences become suggestions to review; a word only changes where the audio is unsure and the lyrics agree around it." />}
                  {!align && <SwitchRow className="px-4" label={av?.claude ? 'Refine with Claude' : 'Refine accuracy'} checked={effective.refine} onChange={(v) => setOpts({ ...opts, refine: v })}
                    help={av?.claude
                      ? 'Re-listens to unsure passages, then Claude reviews them. Its ideas are applied only where the re-listen heard the same word; the rest are suggestions.'
                      : 'Re-listens to unsure passages; a word changes only when the second listen is clearly more confident. Chorus repeats are compared, not copied.'} />}
                  {!align && <SwitchRow className="px-4" label="Identify vocalists" checked={effective.diarize} disabled={!av?.diarize || effective.transcriber !== 'whisperx'} onChange={(v) => setOpts({ ...opts, diarize: v })}
                    help={effective.transcriber !== 'whisperx' ? 'Available with WhisperX.' : av?.diarize ? 'Labels different singers.' : 'Needs Replicate and Hugging Face tokens.'} />}
                </div>
              </div>
            </div>
          )}
          {canRun && (
            <div className="mt-7 flex flex-wrap items-center gap-5 rounded-[18px] border border-white/[0.07] bg-white/[0.025] px-5 py-4">
              <label className="flex min-w-64 flex-1 cursor-pointer items-start gap-3 text-[12.5px] leading-relaxed text-muted">
                <input type="checkbox" className="check mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                I own this audio or have permission to analyse it, and I understand the results are AI-generated and may contain mistakes.
              </label>
              <Button variant="primary" size="lg" className="px-7" onClick={start} disabled={!consent}
                icon={phase === 'error' ? <RotateCcw size={16} /> : <Sparkles size={16} />}>{phase === 'error' ? 'Retry' : align ? 'Synchronise' : 'Analyse'}</Button>
            </div>
          )}
        </section>
      )}

      {error && (
        <div role="alert" className="pop mt-5 flex items-start gap-3 rounded-[14px] border border-bad/30 bg-[rgb(58_14_20/0.55)] px-4 py-3 text-[13px] text-[#ffc4c4] backdrop-blur-xl">
          <AlertTriangle size={16} className="mt-px shrink-0 text-bad" /><span className="flex-1 leading-relaxed">{error}</span>
        </div>
      )}
      {notice && <p className="pop mt-5 rounded-[14px] border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-[13px] text-muted">{notice}</p>}

      {(running || phase === 'error') && (
        <section className="enter-3 mt-7 grid gap-5 @min-[860px]:grid-cols-[minmax(0,1fr)_340px]" aria-live="polite">
          <div className="card p-6">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-[17px] font-semibold tracking-[-0.015em]">{running ? (active ? label(active) : 'Starting…') : 'Analysis stopped'}</h2>
              <span className="tabular shrink-0 text-[12px] font-medium text-muted">Step {Math.min(doneCount + 1, STAGES.length)} of {STAGES.length}</span>
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label="Overall progress" aria-valuenow={Math.round(overall * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out" style={{ width: `${Math.max(3, overall * 100)}%` }} />
            </div>
            <ol className="mt-6">
              {STAGES.map((s, i) => {
                const st = stages[s]
                const last = i === STAGES.length - 1
                return (
                  <li key={s} className="relative flex gap-4 pb-5 last:pb-0">
                    {!last && <span className={cx('absolute top-7 bottom-1 left-[11px] w-[2px] rounded-full', st.state === 'done' || st.state === 'skipped' ? 'bg-accent/35' : 'bg-white/[0.07]')} aria-hidden />}
                    <StageIcon state={st.state} />
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="flex items-baseline gap-3">
                        <span className={cx('flex-1 text-[13.5px]', st.state === 'pending' ? 'text-white/35' : st.state === 'running' ? 'font-semibold text-fg' : 'font-medium text-fg/85')}>{label(s)}</span>
                        {st.state === 'running' && st.fraction !== undefined && <span className="tabular text-[12px] font-medium text-accent">{Math.round(st.fraction * 100)}%</span>}
                        {st.state === 'skipped' && <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10.5px] font-medium text-subtle">Skipped</span>}
                      </div>
                      {st.message && st.state !== 'pending' && <p className="mt-1 text-[12px] leading-relaxed text-muted">{st.message}</p>}
                      {st.state === 'pending' && phase === 'error' && st.message && <p className="mt-1 text-[12px] text-bad">{st.message}</p>}
                      {st.state === 'running' && (
                        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label={LABEL[s]}
                          aria-valuenow={st.fraction !== undefined ? Math.round(st.fraction * 100) : undefined} aria-valuemin={0} aria-valuemax={100}>
                          {st.fraction !== undefined
                            ? <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${st.fraction * 100}%` }} />
                            : <div className="indeterminate h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-accent to-transparent" />}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>
          <aside className="card flex max-h-[520px] flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5 text-[12px]">
              <span className="flex items-center gap-2 font-semibold">{running && <span className="breathe size-1.5 rounded-full bg-ok shadow-[0_0_8px_var(--ok)]" aria-hidden />}Activity</span>
              <span className="tabular font-medium text-muted">{running ? fmtTime(elapsed / 1000) : 'Stopped'}</span>
            </div>
            <ul className="selectable min-h-40 flex-1 space-y-1.5 overflow-y-auto bg-black/20 px-5 py-4 font-mono text-[11px] leading-relaxed text-white/60">
              {log.map((l, i) => <li key={i}><span className="text-white/30">{fmtTime(l.t / 1000)}</span>  {l.text}</li>)}
            </ul>
            {running && (
              <div className="border-t border-white/[0.07] p-2.5">
                <Button variant="danger" className="w-full" icon={<Square size={11} fill="currentColor" />} onClick={cancel}>Cancel analysis</Button>
              </div>
            )}
          </aside>
        </section>
      )}

      {settings && providers && <AiSettings providers={providers} onChange={setProviders} onClose={() => setSettings(false)} />}
    </div>
  )
}

function FreeEngine({ missingMB, partial, onInstalled, onPaid }: { missingMB: number; partial: boolean; onInstalled: (p: Providers) => void; onPaid: () => void }) {
  const [p, setP] = useState<{ fraction: number; message: string; total: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => api.onInstall(setP), [])
  const install = async () => {
    setBusy(true); setError(null)
    try { onInstalled(await api.aiInstallLocal()) }
    catch (e) { const m = (e as Error).message; if (!/cancel/i.test(m)) setError(m); setP(null) }
    finally { setBusy(false) }
  }
  const mb = (f: number, total: number) => Math.round((f * total) / 1048576)
  return (
    <div className="card mb-6 flex gap-4 p-5">
      <IconTile tone="mint"><Cpu size={19} /></IconTile>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold tracking-tight">{partial ? 'Add free vocal separation' : 'Free engine, runs on this PC'}</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          {partial
            ? `Adds a vocal isolation model so the free engine hears the singing without the instrumental. One-time download of about ${missingMB} MB.`
            : `Whisper plus a vocal isolation model. No account, no API key, nothing uploaded. One-time download of about ${missingMB} MB.`}
        </p>
        {busy && p ? (
          <div className="mt-4">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label="Downloading free engine" aria-valuenow={Math.round(p.fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${p.fraction * 100}%` }} />
            </div>
            <div className="mt-2 flex items-center justify-between text-[12px] text-muted">
              <span className="tabular">{p.message} {mb(p.fraction, p.total)} / {mb(1, p.total)} MB</span>
              <Button size="sm" variant="ghost" onClick={() => api.aiCancelInstall()}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={busy ? <Spinner size={13} className="text-accent-fg" /> : <Download size={14} />} onClick={install} disabled={busy}>
              {busy ? 'Starting…' : partial ? 'Download separation model' : 'Download free engine'}
            </Button>
            <Button variant="ghost" onClick={onPaid}>Use a cloud provider instead</Button>
          </div>
        )}
        {error && <p role="alert" className="mt-2 text-[12px] text-bad">{error}</p>}
      </div>
    </div>
  )
}

function AccuracyPicker({ value, installed, onChange, onInstalled }: { value: 'turbo' | 'large'; installed: boolean; onChange: (m: 'turbo' | 'large') => void; onInstalled: (p: Providers) => void }) {
  const [p, setP] = useState<{ fraction: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => api.onInstall((x) => setP((prev) => (prev ? x : prev))), []) // ignore the other installer's progress
  const get = async () => {
    setError(null); setP({ fraction: 0 })
    try { onInstalled(await api.aiInstallLocal({ large: true })); onChange('large') } catch (e) { if (!/cancel/i.test((e as Error).message)) setError((e as Error).message) } finally { setP(null) }
  }
  return (
    <div>
      <span className="mb-2 block text-[12px] font-medium text-muted">Accuracy</span>
      <Segmented label="Accuracy" value={installed ? value : 'turbo'} onChange={(m) => (m === 'large' && !installed ? get() : onChange(m))}
        items={[['turbo', 'Balanced'], ['large', 'Maximum']]} />
      <p className="mt-2 text-[12px] leading-relaxed text-subtle">
        {p ? <span className="tabular">Downloading Whisper large-v3… {Math.round(p.fraction * 100)}% <button className="ml-1 font-medium text-muted underline hover:text-fg" onClick={() => api.aiCancelInstall()}>Cancel</button></span>
          : installed ? (value === 'large' ? 'Whisper large-v3: best on singing, rap and slang. Takes roughly twice as long.' : 'Whisper large-v3-turbo: fast, very good on clear vocals.')
          : 'Maximum uses the full Whisper large-v3 model (better on singing and rap, slower). Choosing it downloads 1.0 GB once.'}
      </p>
      {error && <p className="mt-1 text-[12px] text-bad">{error}</p>}
    </div>
  )
}

function StageIcon({ state }: { state: StageState['state'] }) {
  const base = 'relative z-10 grid size-6 shrink-0 place-items-center rounded-full'
  if (state === 'running') return <span className={cx(base, 'bg-accent/15 ring-1 ring-accent/50')} aria-label="In progress"><Loader2 size={14} className="spin text-accent" /></span>
  if (state === 'done') return <span className={cx(base, 'bg-accent text-accent-fg')} aria-label="Done"><Check size={13} strokeWidth={3} /></span>
  if (state === 'skipped') return <span className={cx(base, 'bg-white/[0.08] text-white/45')} aria-label="Skipped"><Minus size={12} strokeWidth={3} /></span>
  return <span className={cx(base, 'bg-bg ring-1 ring-white/[0.14]')} aria-label="Waiting" />
}

import { useState } from 'react'
import { Check, KeyRound, RotateCcw, Settings, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import { api, KeyName, Providers } from '../api'
import { setPrefs, usePrefs } from '../prefs'
import { Button, cx, IconButton, Modal, Segmented, SwitchRow } from '../ui'

const INFO: { name: KeyName; label: string; env: string; url: string; use: string }[] = [
  { name: 'replicate', label: 'Replicate', env: 'REPLICATE_API_TOKEN', url: 'https://replicate.com/account/api-tokens',
    use: 'Recommended. Runs Demucs vocal separation and WhisperX (Whisper large-v3 with forced word alignment). Roughly a few cents per song.' },
  { name: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY', url: 'https://platform.openai.com/api-keys',
    use: 'Alternative transcriber: Whisper with word timestamps. No vocal separation or forced alignment on its own.' },
  { name: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY', url: 'https://console.anthropic.com/settings/keys',
    use: 'Optional refinement: Claude reviews unclear words using a second listening pass and chorus repeats.' },
  { name: 'huggingface', label: 'Hugging Face', env: 'HF_TOKEN', url: 'https://huggingface.co/settings/tokens',
    use: 'Optional, for identifying different vocalists (WhisperX only). Accept the terms for pyannote/speaker-diarization-3.1 and pyannote/segmentation-3.0 on Hugging Face first.' },
  { name: 'genius', label: 'Genius', env: 'GENIUS_ACCESS_TOKEN', url: 'https://genius.com/api-clients',
    use: 'Optional, for searching Genius. Create an API client and copy its Client Access Token. Genius provides song details and artwork only; lyrics come from LRCLIB.' },
]

export default function AiSettings({ providers, onChange, onClose, onEditProfile }: { providers: Providers; onChange: (p: Providers) => void; onClose: () => void; onEditProfile?: () => void }) {
  const [draft, setDraft] = useState<Partial<Record<KeyName, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [savedName, setSavedName] = useState<KeyName | null>(null)

  const save = async (name: KeyName, value: string | null) => {
    setError(null)
    try {
      onChange(await api.aiSetKey(name, value))
      setDraft((d) => ({ ...d, [name]: '' }))
      setSavedName(name); setTimeout(() => setSavedName(null), 1500)
    } catch (e) { setError((e as Error).message) }
  }

  const prefs = usePrefs()

  return (
    <Modal title="Settings" labelId="ai-settings-title" icon={<Settings size={16} className="text-accent" />} onClose={onClose} width="max-w-2xl">
      <h3 className="t-eyebrow mb-2">General</h3>
      <div className="inset-list">
        <div className="flex flex-wrap items-center gap-4 px-4 py-3.5">
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium text-fg">Lyrics size</span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">How big synced lyric lines are.</span>
          </span>
          <Segmented label="Lyrics size" value={prefs.lyricSize} onChange={(lyricSize) => setPrefs({ lyricSize })} items={[['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']]} />
        </div>
        <div className="flex flex-wrap items-center gap-4 px-4 py-3.5">
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium text-fg">Default lyrics view</span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">Which view songs with synced lyrics open in.</span>
          </span>
          <Segmented label="Default lyrics view" value={prefs.lyricView} onChange={(lyricView) => setPrefs({ lyricView })} items={[['synced', 'Synced'], ['plain', 'Plain']]} />
        </div>
        <SwitchRow className="px-4" label="Colour from artwork" help="Tints the window with the open song's album art." checked={prefs.tint} onChange={(tint) => setPrefs({ tint })} />
        <SwitchRow className="px-4" label="Now playing bar" help="Shows what's playing on this PC, with controls, along the bottom." checked={prefs.nowPlayingBar} onChange={(nowPlayingBar) => setPrefs({ nowPlayingBar })} />
        <SwitchRow className="px-4" label="Open Listening now on launch" help="Starts on live lyrics for whatever is playing instead of Home." checked={prefs.startListening} onChange={(startListening) => setPrefs({ startListening })} />
        <SwitchRow className="px-4" label="Ask before removing songs" help="Confirms before a song leaves your library." checked={prefs.confirmRemove} onChange={(confirmRemove) => setPrefs({ confirmRemove })} />
        <SwitchRow className="px-4" label="Reduce motion" help="Turns off animations, even if Windows' animation setting is on." checked={prefs.reduceMotion} onChange={(reduceMotion) => setPrefs({ reduceMotion })} />
        <div className="flex flex-wrap gap-2.5 px-4 py-3.5">
          {onEditProfile && <Button icon={<UserRound size={14} />} onClick={onEditProfile}>Edit profile</Button>}
          <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => setPrefs(null)}>Reset to defaults</Button>
        </div>
      </div>

      <h3 className="t-eyebrow mt-7 mb-2 flex items-center gap-2"><KeyRound size={13} />AI providers</h3>
      <p className="flex items-start gap-3 rounded-[14px] border border-ok/20 bg-ok/[0.06] px-4 py-3 text-[12px] leading-relaxed text-muted">
        <ShieldCheck size={16} className="mt-px shrink-0 text-ok" />
        Keys stay in Verse's background process, encrypted with Windows' secure storage. They are never shown again and are only sent to the provider they belong to. Environment variables take priority.
      </p>
      {error && <p role="alert" className="mt-3 rounded-[12px] border border-bad/30 bg-bad/[0.08] px-4 py-2.5 text-[13px] text-bad">{error}</p>}
      <div className="inset-list mt-5">
        {INFO.map((k) => {
          const status = providers.keys[k.name]
          return (
            <section key={k.name} className="px-4 py-4">
              <div className="flex items-center gap-2">
                <h3 className="text-[14px] font-semibold tracking-tight">{k.label}</h3>
                <span className={cx('rounded-full px-2 py-0.5 text-[10.5px] font-semibold', status ? 'bg-ok/[0.12] text-ok' : 'bg-white/[0.07] text-subtle')}>
                  {status === 'env' ? `From ${k.env}` : status === 'saved' ? 'Saved' : 'Not set'}
                </span>
                <a href={k.url} target="_blank" rel="noreferrer" className="ml-auto text-[12px] font-medium text-accent hover:underline">Get a key ↗</a>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{k.use}</p>
              {status !== 'env' && (
                <form className="mt-3 flex gap-2.5" onSubmit={(e) => { e.preventDefault(); if (draft[k.name]?.trim()) save(k.name, draft[k.name]!) }}>
                  <input type="password" autoComplete="off" spellCheck={false} value={draft[k.name] ?? ''} aria-label={`${k.label} API key`}
                    onChange={(e) => setDraft((d) => ({ ...d, [k.name]: e.target.value }))} placeholder={status ? 'Paste a new key to replace it' : 'Paste key'}
                    className="field min-w-0 flex-1 font-mono text-[12px]" />
                  <Button variant="primary" className="h-9 px-4" disabled={!draft[k.name]?.trim()} icon={savedName === k.name ? <Check size={14} /> : undefined}>{savedName === k.name ? 'Saved' : 'Save'}</Button>
                  {status === 'saved' && <IconButton label={`Remove ${k.label} key`} tipLeft variant="danger" type="button" onClick={() => save(k.name, null)}><Trash2 size={15} /></IconButton>}
                </form>
              )}
            </section>
          )
        })}
      </div>
    </Modal>
  )
}

import { CSSProperties, useState } from 'react'
import { ArrowLeft, Check, UserRound } from 'lucide-react'
import type { Song } from './api'
import { HOUSE } from './palette'
import { getPrefs } from './prefs'
import { Backdrop, Button, cx, Logo, Modal } from './ui'

// Kept on this PC only (localStorage); nothing here is sent anywhere.
export type Profile = { name: string; accent: string; heardFrom: string; listensOn: string[]; goals: string[] }

const ACCENTS: Record<string, { label: string; accent: string; deep: string; soft: string; fg: string }> = {
  gold: { label: 'Gold', accent: '#ffcf3a', deep: '#e9a917', soft: 'rgb(255 207 58 / 0.13)', fg: '#1c1503' },
  rose: { label: 'Rose', accent: '#ff8fa3', deep: '#e86a82', soft: 'rgb(255 143 163 / 0.13)', fg: '#2a0a10' },
  lavender: { label: 'Lavender', accent: '#b9a4ff', deep: '#957bf0', soft: 'rgb(185 164 255 / 0.13)', fg: '#150c2e' },
  mint: { label: 'Mint', accent: '#7fe0b0', deep: '#52c48f', soft: 'rgb(127 224 176 / 0.13)', fg: '#06200f' },
  sky: { label: 'Sky', accent: '#7cc4ff', deep: '#4fa6ea', soft: 'rgb(124 196 255 / 0.13)', fg: '#061a2c' },
}
const HEARD = ['A friend', 'TikTok', 'Instagram', 'YouTube', 'Reddit', 'Search engine', 'Other']
const LISTEN = ['Spotify', 'SoundCloud', 'Local MP3 files', 'Something else']
const GOALS = ['Read lyrics while I listen', 'Sing along (karaoke)', 'Sync lyrics with AI', 'Build a lyrics library']

export function loadProfile(): Profile | null {
  try { return JSON.parse(localStorage.getItem('profile') ?? 'null') } catch { return null }
}

export function applyAccent(key = 'gold') {
  const a = ACCENTS[key] ?? ACCENTS.gold, s = document.documentElement.style
  s.setProperty('--accent', a.accent); s.setProperty('--accent-deep', a.deep); s.setProperty('--accent-soft', a.soft); s.setProperty('--accent-fg', a.fg)
}

function Choices({ options, value, onChange, multi }: { options: string[]; value: string[]; onChange: (v: string[]) => void; multi?: boolean }) {
  return (
    <div role={multi ? 'group' : 'radiogroup'} className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((o, i) => {
        const on = value.includes(o)
        return (
          <button key={o} type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={on} style={{ animationDelay: `${120 + i * 45}ms`, animationFillMode: 'backwards' }}
            onClick={() => onChange(multi ? (on ? value.filter((x) => x !== o) : [...value, o]) : [o])}
            className={cx('rise flex h-12 items-center justify-between rounded-[12px] border px-4 text-left text-[14px] transition-[background-color,border-color,color,transform] duration-200 active:scale-[0.98]',
              on ? 'border-accent/60 bg-accent-soft text-fg' : 'border-line2 bg-panel text-muted hover:bg-panel2 hover:text-fg')}>
            {o}{on && <Check size={16} className="pop text-accent" />}
          </button>
        )
      })}
    </div>
  )
}

export default function Onboarding({ onDone }: { onDone: (p: Profile) => void }) {
  const [step, setStep] = useState(0)
  const [p, setP] = useState<Profile>({ name: '', accent: 'gold', heardFrom: '', listensOn: [], goals: [] })
  const set = (patch: Partial<Profile>) => setP((x) => ({ ...x, ...patch }))

  const steps = [
    { title: 'What should we call you?', sub: 'This is how Verse greets you.', ok: !!p.name.trim(), body: (
      <input autoFocus value={p.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} aria-label="Display name"
        onKeyDown={(e) => { if (e.key === 'Enter' && p.name.trim()) go(1) }}
        placeholder="Your name" className="field mt-4 h-12 text-[16px]" />
    ) },
    { title: 'Pick your colour', sub: 'Used for buttons and highlights. Songs still tint the background with their artwork.', ok: true, body: (
      <div role="radiogroup" aria-label="Accent colour" className="mt-6 flex flex-wrap gap-3">
        {Object.entries(ACCENTS).map(([k, a], i) => (
          <button key={k} type="button" role="radio" aria-checked={p.accent === k} onClick={() => { set({ accent: k }); applyAccent(k) }} style={{ animationDelay: `${120 + i * 45}ms`, animationFillMode: 'backwards' }}
            className={cx('rise flex flex-col items-center gap-2 rounded-[14px] border px-4 py-3 text-[12.5px] transition-[background-color,border-color,transform] duration-300 hover:-translate-y-0.5 active:scale-95',
              p.accent === k ? 'border-accent/60 bg-accent-soft text-fg' : 'border-line2 bg-panel text-muted hover:bg-panel2')}>
            <span className={cx('grid size-10 place-items-center rounded-full transition-transform duration-300', p.accent === k && 'scale-110')} style={{ background: a.accent, boxShadow: p.accent === k ? `0 6px 20px -6px ${a.accent}` : undefined }}>
              {p.accent === k && <Check size={18} className="pop" style={{ color: a.fg }} />}
            </span>
            {a.label}
          </button>
        ))}
      </div>
    ) },
    { title: 'How did you hear about Verse?', sub: 'Helps us know what is working.', ok: !!p.heardFrom, body:
      <Choices options={HEARD} value={[p.heardFrom]} onChange={([v]) => set({ heardFrom: v })} /> },
    { title: 'Where do you listen to music?', sub: 'Pick all that apply.', ok: p.listensOn.length > 0, body:
      <Choices multi options={LISTEN} value={p.listensOn} onChange={(v) => set({ listensOn: v })} /> },
    { title: 'What brings you to Verse?', sub: 'Pick all that apply.', ok: p.goals.length > 0, body:
      <Choices multi options={GOALS} value={p.goals} onChange={(v) => set({ goals: v })} /> },
  ]
  const s = steps[step], last = step === steps.length - 1
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')
  const [done, setDone] = useState(false)
  const go = (n: number) => { setDir(n > step ? 'fwd' : 'back'); setStep(n) }
  const finish = (profile: Profile) => {
    try { localStorage.setItem('profile', JSON.stringify(profile)) } catch { /* storage unavailable: onboarding shows again next launch */ }
    setDone(true)
    setTimeout(() => onDone(profile), matchMedia('(prefers-reduced-motion: reduce)').matches || getPrefs().reduceMotion ? 0 : 1500)
  }
  const next = () => (last ? finish(p) : go(step + 1))
  const a = ACCENTS[p.accent] ?? ACCENTS.gold

  return (
    <div className="fade fixed inset-0 z-[60] grid place-items-center overflow-hidden bg-bg p-4" role="dialog" aria-modal="true" aria-labelledby="onb-title">
      {/* The aurora takes on the colour being picked. */}
      <Backdrop full theme={{ ...HOUSE, c1: a.deep, c2: a.accent, accent: a.accent, glow: a.soft }} className="opacity-80 transition-opacity" />
      {done ? (
        <div className="pop relative flex flex-col items-center text-center" role="status">
          <div className="relative">
            {Array.from({ length: 14 }, (_, i) => (
              <span key={i} className="burst absolute top-1/2 left-1/2 -mt-1 -ml-1 size-2 rounded-full" aria-hidden
                style={{ '--r': `${(i * 360) / 14}deg`, background: i % 3 ? a.accent : '#fff', animationDelay: `${(i % 4) * 30}ms` } as CSSProperties} />
            ))}
            <span className="grid size-20 place-items-center rounded-full text-[32px] font-semibold shadow-[0_14px_40px_-10px_var(--accent)]" style={{ background: a.accent, color: a.fg }}>
              {p.name.trim()[0]?.toUpperCase()}
            </span>
          </div>
          <h1 id="onb-title" className="t-title mt-7">You're all set, {p.name.trim()} ✨</h1>
          <p className="enter-2 mt-2 text-[14px] text-muted">Let's find some lyrics.</p>
        </div>
      ) : (
      <div className="relative w-full max-w-[520px]">
        <div className="enter flex items-center gap-2.5"><span className="float inline-block"><Logo size={28} /></span><span className="font-serif text-[22px] leading-none">Verse</span></div>
        <div className="enter-2 mt-8 flex gap-1.5" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((_, i) => (
            <span key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-panel3">
              <span className={cx('block h-full origin-left rounded-full bg-accent transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]', i <= step ? 'scale-x-100' : 'scale-x-0')} />
            </span>
          ))}
        </div>
        <div key={step} className={cx(dir === 'fwd' ? 'step-fwd' : 'step-back', 'mt-8 min-h-[300px]')}>
          <h1 id="onb-title" className="t-title">{s.title}</h1>
          <p className="mt-2 text-[14px] text-muted">{s.sub}</p>
          {step === 0 && (
            <div className="mt-6 flex items-center gap-3">
              <span key={p.name.trim()[0] ?? ''} className="pop grid size-12 shrink-0 place-items-center rounded-full text-[20px] font-semibold transition-colors duration-300"
                style={{ background: p.name.trim() ? a.accent : 'var(--panel3, rgb(255 255 255 / 0.08))', color: a.fg }} aria-hidden>
                {p.name.trim()[0]?.toUpperCase() || '?'}
              </span>
              <span className="text-[13px] text-muted">{p.name.trim() ? `Hey ${p.name.trim()} 👋` : 'Waiting for a name…'}</span>
            </div>
          )}
          {s.body}
        </div>
        <div className="mt-6 flex items-center gap-2">
          {step > 0 && <Button size="lg" variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => go(step - 1)}>Back</Button>}
          {step > 1 && <Button size="lg" variant="ghost" className="ml-auto" onClick={next}>Skip</Button>}
          <Button size="lg" variant="primary" className={cx('transition-transform active:scale-[0.97]', step <= 1 && 'ml-auto')} disabled={!s.ok} onClick={next}>{last ? 'Start using Verse' : 'Continue'}</Button>
        </div>
      </div>
      )}
    </div>
  )
}

// Edit the name and colour picked during onboarding. Same storage, still local only.
export function ProfileDialog({ profile, library, onSave, onClose }: { profile: Profile; library: Song[]; onSave: (p: Profile) => void; onClose: () => void }) {
  const [p, setP] = useState(profile)
  const close = () => { applyAccent(profile.accent); onClose() } // undo the live colour preview
  const save = () => {
    try { localStorage.setItem('profile', JSON.stringify(p)) } catch { /* storage unavailable: change lasts until restart */ }
    onSave(p); onClose()
  }
  const a = ACCENTS[p.accent] ?? ACCENTS.gold
  const stats: [string, number][] = [
    ['Songs', library.length],
    ['Favourites', library.filter((s) => s.favorite).length],
    ['AI lyrics', library.filter((s) => s.ai).length],
  ]
  return (
    <Modal title="Profile" labelId="profile-title" icon={<UserRound size={16} className="text-accent" />} onClose={close} width="max-w-xl">
      {/* Header card: avatar and name in the chosen colour, so the preview is live. */}
      <div className="relative overflow-hidden rounded-[18px] border border-line2 p-5" style={{ background: `radial-gradient(120% 140% at 0% 0%, ${a.soft}, transparent 60%)` }}>
        <div className="flex items-center gap-4">
          <span className="grid size-16 shrink-0 place-items-center rounded-full text-[26px] font-semibold shadow-[0_10px_30px_-10px_var(--accent)]" style={{ background: a.accent, color: a.fg }} aria-hidden>
            {p.name.trim()[0]?.toUpperCase() || '?'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[20px] font-semibold tracking-tight">{p.name.trim() || 'Your name'}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">Stored on this PC only</div>
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-3 gap-2">
          {stats.map(([l, n]) => (
            <div key={l} className="rounded-[12px] bg-white/[0.05] px-3 py-2.5">
              <dt className="text-[11.5px] text-muted">{l}</dt>
              <dd className="tabular mt-0.5 text-[20px] font-semibold tracking-tight">{n}</dd>
            </div>
          ))}
        </dl>
      </div>

      <label className="mt-6 block">
        <span className="t-eyebrow">Name</span>
        <input value={p.name} maxLength={40} onChange={(e) => setP({ ...p, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && p.name.trim()) save() }}
          placeholder="Your name" className="field mt-2 h-11 text-[15px]" />
      </label>

      <div className="t-eyebrow mt-6">Colour</div>
      <div role="radiogroup" aria-label="Accent colour" className="mt-2 grid grid-cols-5 gap-2">
        {Object.entries(ACCENTS).map(([k, c]) => (
          <button key={k} type="button" role="radio" aria-checked={p.accent === k} onClick={() => { setP({ ...p, accent: k }); applyAccent(k) }}
            className={cx('flex flex-col items-center gap-2 rounded-[12px] border py-2.5 text-[12px] transition-colors',
              p.accent === k ? 'border-accent/60 bg-accent-soft text-fg' : 'border-line2 bg-panel text-muted hover:bg-panel2 hover:text-fg')}>
            <span className="grid size-8 place-items-center rounded-full" style={{ background: c.accent }}>{p.accent === k && <Check size={15} style={{ color: c.fg }} />}</span>
            {c.label}
          </button>
        ))}
      </div>

      <Chips title="I listen on" options={LISTEN} value={p.listensOn} onChange={(listensOn) => setP({ ...p, listensOn })} />
      <Chips title="I'm here to" options={GOALS} value={p.goals} onChange={(goals) => setP({ ...p, goals })} />

      <div className="mt-7 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!p.name.trim()} onClick={save}>Save</Button>
      </div>
    </Modal>
  )
}

function Chips({ title, options, value, onChange }: { title: string; options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <>
      <div className="t-eyebrow mt-6">{title}</div>
      <div role="group" aria-label={title} className="mt-2 flex flex-wrap gap-2">
        {options.map((o) => {
          const on = value.includes(o)
          return (
            <button key={o} type="button" role="checkbox" aria-checked={on} onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
              className={cx('flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors',
                on ? 'border-accent/60 bg-accent-soft text-fg' : 'border-line2 text-muted hover:bg-panel2 hover:text-fg')}>
              {on && <Check size={13} className="text-accent" />}{o}
            </button>
          )
        })}
      </div>
    </>
  )
}

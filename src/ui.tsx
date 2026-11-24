import { ButtonHTMLAttributes, CSSProperties, ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Loader2, Music, X } from 'lucide-react'
import type { Theme } from './palette'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
  tip?: string
  tipPos?: 'left' | 'up' | 'up left'
}

// Prominent actions are lit lavender capsules; secondary ones are frosted capsules with a fine edge; toolbar
// actions are quiet until hovered. All of them read as controls, never as decoration.
const VARIANT = { primary: 'btn-primary', secondary: 'btn-secondary', ghost: 'btn-ghost', danger: 'btn-danger' }
const SIZE = { sm: 'h-7 px-3 text-[12.5px]', md: 'h-9 px-4', lg: 'h-11 px-5 text-[14px]' }

export function Button({ variant = 'secondary', size = 'md', icon, tip, tipPos, className, children, ...p }: BtnProps) {
  return (
    <button {...p} data-tip={tip} data-tip-pos={tipPos} className={cx('btn', SIZE[size], VARIANT[variant], className)}>
      {icon}{children}
    </button>
  )
}

// Icon-only button: the label doubles as tooltip and accessible name. Secondary ones are circles.
export function IconButton({ label, size = 'md', variant = 'ghost', className, children, tipLeft, tipPos, ...p }:
  Omit<BtnProps, 'icon' | 'tip'> & { label: string; tipLeft?: boolean }) {
  return (
    <button {...p} aria-label={label} data-tip={label} data-tip-pos={tipPos ?? (tipLeft ? 'left' : undefined)}
      className={cx('btn !gap-0 !px-0', size === 'sm' ? 'size-7' : size === 'lg' ? 'size-11' : 'size-9', VARIANT[variant], variant === 'secondary' && '!rounded-full', className)}>
      {children}
    </button>
  )
}

export function Segmented<T extends string>({ value, items, onChange, label, size = 'md' }: { value: T; items: [T, string][]; onChange: (v: T) => void; label: string; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" aria-label={label} className="segmented">
      {items.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={size === 'sm' ? 'h-6' : 'h-[26px]'}>{l}</button>
      ))}
    </div>
  )
}

export function SwitchRow({ label, help, checked, disabled, onChange, className }: { label: string; help: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; className?: string }) {
  return (
    <label className={cx('flex items-start gap-4 py-3.5', disabled ? 'opacity-50' : 'cursor-pointer', className)}>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-fg">{label}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{help}</span>
      </span>
      <input type="checkbox" role="switch" className="switch mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function Menu({ children, onClose, align = 'left', width = 'w-60' }: { children: ReactNode; onClose: () => void; align?: 'left' | 'right'; width?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const c = () => onClose()
    window.addEventListener('keydown', k)
    const t = setTimeout(() => window.addEventListener('click', c), 0) // ignore the click that opened it
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('click', c); clearTimeout(t) }
  }, [onClose])
  return (
    <div role="menu" className={cx('glass-strong pop absolute z-40 mt-2 rounded-[14px] p-1.5', width, align === 'right' ? 'right-0' : 'left-0')}>
      {children}
    </div>
  )
}

export function MenuItem({ icon, children, onClick, hint }: { icon?: ReactNode; children: ReactNode; onClick: () => void; hint?: string }) {
  return (
    <button role="menuitem" onClick={onClick} className="flex h-[34px] w-full items-center gap-2.5 rounded-[9px] px-2.5 text-left text-[13px] text-fg hover:bg-white/[0.09] focus-visible:bg-white/[0.09]">
      <span className="text-muted">{icon}</span><span className="flex-1">{children}</span>{hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </button>
  )
}

export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <div className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase first:pt-1.5" role="presentation">{children}</div>
)

// Songs without artwork get a cover of their own: a muted tint picked from the title, with its first letter.
const TINTS = ['#e8a87c', '#e6b8a2', '#9fc5b8', '#e3c56f', '#d89a9e', '#a9bfdc', '#c7b299', '#b7cf8f']
export const tintFor = (title = '') => TINTS[[...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length]
export function TitleCover({ title, size }: { title?: string; size: number }) {
  const ch = title?.trim().match(/\p{L}|\p{N}/u)?.[0]
  return (
    <span className="grid size-full place-items-center font-serif leading-none text-[#12110f]" style={{ background: tintFor(title), fontSize: size * 0.5 }} aria-hidden>
      {ch ?? <Music size={Math.max(14, size / 3.4)} strokeWidth={1.5} />}
    </span>
  )
}

export function Artwork({ src, title, size, className, style }: { src?: string; title?: string; size: number; className?: string; style?: CSSProperties }) {
  const radius = size >= 120 ? 'rounded-[14px]' : size >= 64 ? 'rounded-[10px]' : size >= 36 ? 'rounded-[7px]' : 'rounded-[5px]'
  return (
    <div className={cx('relative grid shrink-0 place-items-center overflow-hidden bg-white/[0.05]', radius, className)} style={{ width: size, height: size, ...style }}>
      {src ? <img src={src} alt="" className="size-full object-cover" draggable={false} /> : title !== undefined ? <TitleCover title={title} size={size} /> : <Music size={Math.max(14, size / 3.4)} className="text-white/25" strokeWidth={1.5} />}
      <span className={cx('pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/[0.08]', radius)} aria-hidden />
    </div>
  )
}

// Verse's mark: a V caught mid karaoke wipe, half sung (yellow), half to come.
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <img src="./verse-mark.svg" alt="" width={size} height={size} draggable={false} className="block shrink-0" aria-hidden />
  )
}

// Small lit squircle for feature and empty-state icons. Pass a gradient to vary the hue.
export const TILES = {
  violet: { '--tile': 'var(--accent)' },
  rose: { '--tile': '#ff8a5c' },
  ocean: { '--tile': 'var(--fg)' },
  amber: { '--tile': '#f0a35a' },
  mint: { '--tile': '#9fcf7c' },
} as const
export function IconTile({ children, tone = 'violet', size = 40, className }: { children: ReactNode; tone?: keyof typeof TILES; size?: number; className?: string }) {
  return <span className={cx('icon-tile', className)} style={{ ...TILES[tone], width: size, height: size, borderRadius: size * 0.3 } as CSSProperties} aria-hidden>{children}</span>
}

// Artwork-tinted background for music screens: drifting colour fields from the palette, the artwork as texture,
// a scrim for contrast and fine grain. Colours morph when the song changes.
export function Backdrop({ theme, src, full, className }: { theme: Theme; src?: string; full?: boolean; className?: string }) {
  return (
    <div className={cx('backdrop', full && 'backdrop-full', className)} aria-hidden
      style={{ '--c1': theme.c1, '--c2': theme.c2, '--c3': theme.c3, '--c4': theme.c4 } as CSSProperties}>
      <div className="bd-base" />
      <div className="bd-blob bd-1" /><div className="bd-blob bd-2" /><div className="bd-blob bd-3" /><div className="bd-blob bd-4" />
      {src && <img key={src} src={src} alt="" className="bd-art glow-in" draggable={false} />}
      <div className="bd-scrim" />
      <div className="bd-grain" />
    </div>
  )
}

export function EmptyState({ icon, tone, title, children, action }: { icon: ReactNode; tone?: keyof typeof TILES; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <IconTile tone={tone} size={48}>{icon}</IconTile>
      <div className="mt-4 text-[15px] font-semibold tracking-tight">{title}</div>
      {children && <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export const Spinner = ({ size = 16, className }: { size?: number; className?: string }) => <Loader2 size={size} className={cx('spin text-muted', className)} aria-hidden />

export function Toast({ children }: { children: ReactNode }) {
  return createPortal(
    <div role="status" className="glass-strong pop fixed bottom-7 left-1/2 z-[70] -translate-x-1/2 rounded-full px-5 py-2.5 text-[13px] font-medium text-fg">{children}</div>,
    document.body,
  )
}

export function Modal({ title, icon, onClose, children, width = 'max-w-lg', labelId }: { title: string; icon?: ReactNode; onClose: () => void; children: ReactNode; width?: string; labelId: string }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  // Keyboard focus stays inside the dialog while it's open and goes back to whatever opened it afterwards.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const focusable = () => [...(box.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter((el) => el.offsetParent !== null)
    if (!box.current?.contains(document.activeElement)) (focusable().find((el) => el.getAttribute('aria-label') !== 'Close') ?? box.current)?.focus()
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); return }
      if (e.key !== 'Tab') return
      const els = focusable()
      if (!els.length) { e.preventDefault(); return }
      const first = els[0], last = els[els.length - 1], at = document.activeElement
      if (e.shiftKey && (at === first || !box.current?.contains(at))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (at === last || !box.current?.contains(at))) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', k, true)
    return () => { window.removeEventListener('keydown', k, true); if (opener?.isConnected) opener.focus() }
  }, [])
  return createPortal(
    <div className="fade fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-md sm:p-8" onClick={onClose}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={labelId} onClick={(e) => e.stopPropagation()}
        className={cx('glass-strong pop flex max-h-full w-full flex-col overflow-hidden rounded-[22px] outline-none', width)}>
        <div className="flex shrink-0 items-center justify-between gap-4 px-6 pt-5 pb-4">
          <h2 id={labelId} className="flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.015em]">{icon}{title}</h2>
          <IconButton label="Close" size="sm" variant="secondary" onClick={onClose}><X size={15} /></IconButton>
        </div>
        <div className="min-h-0 overflow-y-auto px-6 pb-6">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export const SectionTitle = ({ children, action, sub }: { children: ReactNode; action?: ReactNode; sub?: ReactNode }) => (
  <div className="mb-4 flex items-end justify-between gap-4">
    <div>
      <h2 className="t-section">{children}</h2>
      {sub && <p className="mt-0.5 text-[13px] text-muted">{sub}</p>}
    </div>
    {action}
  </div>
)

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="rounded-[6px] border border-white/[0.12] bg-white/[0.06] px-1.5 py-px font-mono text-[10.5px] text-muted shadow-[inset_0_-1px_0_rgb(0_0_0/0.3)]">{children}</kbd>
)

export function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-muted">{label}</span>
      <span className="relative block">
        <select value={value} onChange={(e) => onChange(e.target.value)} className="field appearance-none pr-9">
          {children}
        </select>
        <ChevronDown size={15} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-subtle" />
      </span>
    </label>
  )
}

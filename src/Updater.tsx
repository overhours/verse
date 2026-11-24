import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download } from 'lucide-react'
import { Button, cx } from './ui'

type Ready = { version: string; notes: string }

// Bars of a sound wave, staggered so the motion travels across.
function Wave({ big }: { big?: boolean }) {
  const bars = big ? 23 : 5
  return (
    <div className={cx('flex items-center', big ? 'h-24 gap-[5px]' : 'h-3.5 gap-[2px]')} aria-hidden>
      {Array.from({ length: bars }, (_, i) => {
        const h = big ? 30 + 70 * Math.sin((i / (bars - 1)) * Math.PI) : 100
        return <span key={i} className={cx('wave-bar rounded-full bg-accent', big ? 'w-[5px]' : 'w-[2px]')}
          style={{ height: `${h}%`, animationDelay: `${-(i * (big ? 0.09 : 0.18)) % 1.1}s` }} />
      })}
    </div>
  )
}

// Shown in the title bar once a new version has finished downloading in the background.
export default function Updater() {
  const [ready, setReady] = useState<Ready | null>(null)
  const [open, setOpen] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.ipc.updateStatus().then((r) => { if (r.ok && r.data) setReady(r.data as Ready) })
    return window.ipc.onUpdate((p) => setReady(p as Ready))
  }, [])

  useEffect(() => {
    if (!open || installing) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, installing])

  const install = async () => {
    setInstalling(true)
    setError(null)
    const r = await window.ipc.updateInstall()
    if (!r.ok) { setInstalling(false); setError(r.message) }
  }

  if (!ready) return null
  return (
    <>
      <button onClick={() => setOpen(true)} className="no-drag flash flex h-7 items-center gap-2 rounded-full bg-accent px-3 text-[12.5px] font-semibold text-accent-fg">
        <Wave />Update
      </button>
      {open && createPortal(
        <div className="fade fixed inset-0 z-[80] grid place-items-center bg-black/70 p-6 backdrop-blur-xl" onClick={() => !installing && setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="update-title" onClick={(e) => e.stopPropagation()}
            className="glass-strong pop flex w-full max-w-md flex-col items-center rounded-[26px] px-8 pt-9 pb-7 text-center">
            <Wave big />
            <h2 id="update-title" className="mt-6 font-serif text-[30px] leading-none">{installing ? 'Updating Verse…' : `Verse ${ready.version}`}</h2>
            <p className="mt-2 text-[13px] text-muted">{installing ? 'Verse will close for a few seconds and reopen on its own.' : 'A new version is ready to install.'}</p>
            {!installing && ready.notes && (
              <p className="mt-5 max-h-40 w-full overflow-y-auto rounded-2xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-left text-[13px] leading-relaxed whitespace-pre-line text-fg/90">{ready.notes}</p>
            )}
            {error && <p role="alert" className="mt-4 text-[13px] text-bad">{error}</p>}
            {!installing && (
              <div className="mt-6 flex w-full gap-2.5">
                <Button className="flex-1" onClick={() => setOpen(false)}>Later</Button>
                <Button variant="primary" className="flex-1" icon={<Download size={15} />} onClick={install} autoFocus>Update now</Button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

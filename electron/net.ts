import { Cancelled } from './audio'

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new Cancelled())
  const t = setTimeout(() => { signal?.removeEventListener('abort', on); resolve() }, ms)
  const on = () => { clearTimeout(t); reject(new Cancelled()) }
  signal?.addEventListener('abort', on, { once: true })
})

// Retries network failures, 429 and 5xx with backoff (honouring Retry-After). Other statuses return to the caller.
export async function fetchRetry(url: string, init: RequestInit & { signal?: AbortSignal }, tries = 4, service = 'The service'): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined
    try {
      res = await fetch(url, init)
    } catch (e) {
      if (init.signal?.aborted) throw new Cancelled()
      if (attempt >= tries) throw new Error(`${service} is ghosting us 👻 check your internet and try again.`)
    }
    if (res && res.status !== 429 && res.status < 500) return res
    if (res && attempt >= tries) return res
    const ra = Number(res?.headers.get('retry-after'))
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** (attempt - 1), init.signal ?? undefined)
  }
}

export async function errorText(res: Response, service: string) {
  let detail = ''
  try { const j = await res.json(); detail = j.detail ?? j.error?.message ?? j.error ?? j.title ?? '' } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) return `${service} rejected the API key. Check it in AI settings.`
  if (res.status === 402) return `${service} needs billing set up on your account before it can run this.`
  if (res.status === 413) return `The audio is too large for ${service}.`
  if (res.status === 429) return `${service} is rate-limiting requests. Wait a minute and retry.`
  return `${service} returned an error (${res.status})${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}.`
}

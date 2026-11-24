import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

// API keys live only in the main process: from environment variables, or saved encrypted with the OS keystore
// (DPAPI on Windows). The UI can set or clear a key but never read one back.
export const KEYS = {
  replicate: 'REPLICATE_API_TOKEN',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  huggingface: 'HF_TOKEN',
  genius: 'GENIUS_ACCESS_TOKEN',
} as const
export type KeyName = keyof typeof KEYS

const file = () => path.join(app.getPath('userData'), 'keys.json')
const load = (): Partial<Record<KeyName, string>> => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')) } catch { return {} } }

export function getKey(name: KeyName): string | undefined {
  const env = process.env[KEYS[name]]?.trim()
  if (env) return env
  const enc = load()[name]
  if (!enc || !safeStorage.isEncryptionAvailable()) return undefined
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')) } catch { return undefined }
}

export function keyStatus() {
  const saved = load()
  return Object.fromEntries((Object.keys(KEYS) as KeyName[]).map((k) =>
    [k, process.env[KEYS[k]]?.trim() ? 'env' : saved[k] ? 'saved' : null])) as Record<KeyName, 'env' | 'saved' | null>
}

export function setKey(name: KeyName, value: string | null) {
  if (!(name in KEYS)) throw new Error('Unknown key.')
  const all = load()
  if (value === null || !value.trim()) delete all[name]
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`Secure storage isn't available on this system. Set the ${KEYS[name]} environment variable instead.`)
    if (/\s/.test(value.trim()) || value.trim().length < 10) throw new Error("That doesn't look like a valid key.")
    all[name] = safeStorage.encryptString(value.trim()).toString('base64')
  }
  fs.writeFileSync(`${file()}.tmp`, JSON.stringify(all))
  fs.renameSync(`${file()}.tmp`, file())
  return keyStatus()
}

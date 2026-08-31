import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * API keys, kept apart from the settings and encrypted.
 *
 * Settings are ordinary JSON: convenient to look at and edit by hand. The key
 * to a paid account has no business being there, so it is encrypted by the
 * system store (Keychain on macOS, DPAPI on Windows) and lives in its own file.
 */
interface Secrets {
  [key: string]: string
}

function secretsFile(): string {
  return path.join(app.getPath('userData'), 'secrets.bin')
}

let cache: Secrets | null = null

async function load(): Promise<Secrets> {
  if (cache) return cache
  const file = secretsFile()
  if (!existsSync(file)) {
    cache = {}
    return cache
  }
  try {
    const raw = await readFile(file)
    // Nothing stored means nothing to decrypt. Reading the file at all reaches
    // for the system store, and on macOS that asks for the keychain password:
    // people who never entered a key were being asked for one at every launch.
    if (raw.length === 0) {
      cache = {}
      return cache
    }
    // If the system cannot encrypt (Linux without a keyring), the file sits in
    // plain text, and the interface says so honestly.
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    cache = JSON.parse(json) as Secrets
  } catch {
    // A file that is damaged or encrypted with somebody else's key means starting
    // from scratch, otherwise the application will not launch at all.
    cache = {}
  }
  return cache
}

export async function getSecret(key: string): Promise<string> {
  return (await load())[key] ?? ''
}

export async function setSecret(key: string, value: string): Promise<void> {
  const secrets = await load()
  if (value) secrets[key] = value
  else delete secrets[key]
  cache = secrets

  // An empty set is not stored: an encrypted "{}" is still a file, and its
  // presence alone made every later launch ask for the keychain password.
  // Removing the last key removes the file.
  if (Object.keys(secrets).length === 0) {
    await rm(secretsFile(), { force: true })
    return
  }

  const json = JSON.stringify(secrets)
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8')
  await writeFile(secretsFile(), data)
}

/** Whether there is a key: enough for the interface, which does not need the value itself. */
export async function hasSecret(key: string): Promise<boolean> {
  return (await getSecret(key)).length > 0
}

/**
 * Whether a key would be stored encrypted.
 *
 * On macOS and Windows the answer is known without asking: the Keychain and
 * DPAPI are always there. Asking is not free — the macOS call reaches into the
 * Keychain and puts up the password prompt, and it was doing that just to fill
 * in a caption on a settings screen. Only Linux, where there may be no keyring
 * at all, is actually probed.
 */
export function encryptionAvailable(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return safeStorage.isEncryptionAvailable()
}

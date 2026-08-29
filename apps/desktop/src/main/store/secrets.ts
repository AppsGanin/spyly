import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
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

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

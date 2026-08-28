import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * Ключи доступа — отдельно от настроек и в зашифрованном виде.
 *
 * Настройки лежат обычным JSON: их удобно смотреть и править руками. Ключ от
 * платного аккаунта там оказаться не должен, поэтому он шифруется системным
 * хранилищем (Keychain на macOS, DPAPI на Windows) и живёт в своём файле.
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
    // Если система не умеет шифровать (Linux без ключницы), файл лежит открытым
    // текстом — об этом честно сказано в интерфейсе.
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    cache = JSON.parse(json) as Secrets
  } catch {
    // Битый или зашифрованный чужим ключом файл — начинаем с чистого листа,
    // иначе приложение не запустится вовсе.
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

/** Есть ли ключ — интерфейсу этого достаточно, само значение ему не нужно. */
export async function hasSecret(key: string): Promise<boolean> {
  return (await getSecret(key)).length > 0
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

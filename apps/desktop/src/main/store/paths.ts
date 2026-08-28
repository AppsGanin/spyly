import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let rootOverride: string | null = null

export function setStorageRoot(dir: string): void {
  rootOverride = dir
}

export function storageRoot(): string {
  return rootOverride ?? path.join(os.homedir(), 'Spyly')
}

export function meetingsDir(): string {
  return path.join(storageRoot(), 'meetings')
}

export function speakersFile(): string {
  return path.join(storageRoot(), 'speakers.json')
}

export function indexFile(): string {
  return path.join(storageRoot(), 'index.json')
}

export function meetingDir(id: string): string {
  return path.join(meetingsDir(), id)
}

export function meetingFile(id: string, name: string): string {
  return path.join(meetingDir(id), name)
}

export function audioFile(id: string, track: 'mic' | 'system' | 'mix'): string {
  return path.join(meetingDir(id), 'audio', `${track}.wav`)
}

/** Транслитерация для имени папки: кириллица в путях работает, но мешает в терминале. */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
}

export function slugify(input: string): string {
  const lower = input.toLowerCase().trim()
  let out = ''
  for (const ch of lower) {
    if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch]
    else if (/[a-z0-9]/.test(ch)) out += ch
    else if (/[\s\-_./\\]/.test(ch)) out += '-'
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'sozvon'
}

/** `2026-08-27--sozvon-po-billingu--a1b2` — сортируется по дате и читается глазами. */
export function makeMeetingId(title: string, when: Date): string {
  const date = when.toISOString().slice(0, 10)
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${date}--${slugify(title)}--${suffix}`
}

export async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

export async function ensureMeetingDirs(id: string): Promise<void> {
  await ensureDir(path.join(meetingDir(id), 'audio'))
}

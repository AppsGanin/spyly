import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { Settings } from '../../shared/ipc.js'
import { storageRoot } from './paths.js'

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function defaults(): Settings {
  return {
    language: 'ru',
    theme: 'dark',
    uiLang: 'ru',
    asrModel: '',
    llmProvider: 'anthropic',
    openAiCompatible: { baseUrl: '', model: '' },
    liveTranscription: true,
    autoTranscribe: true,
    autoSummarize: true,
    autoDetectCalls: 'notify',
    storageDir: storageRoot(),
    onboardingDone: false,
    preferredApps: []
  }
}

let cache: Settings | null = null

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache
  const file = settingsFile()
  let stored: Partial<Settings> = {}
  if (existsSync(file)) {
    try {
      stored = JSON.parse(await readFile(file, 'utf8')) as Partial<Settings>
    } catch {
      // A damaged settings file must not stand in the way of startup, so we fall back to defaults.
    }
  }
  const merged = { ...defaults(), ...stored }
  merged.openAiCompatible = merged.openAiCompatible ?? defaults().openAiCompatible
  cache = merged
  return merged
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next: Settings = { ...current, ...patch }
  cache = next
  await writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

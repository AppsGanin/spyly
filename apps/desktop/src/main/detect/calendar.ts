import { t } from '@spyly/core'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * События календаря вокруг текущего момента.
 *
 * Читает их нативный хелпер: у Electron доступа к EventKit нет. Календарь
 * нужен ровно для одного — чтобы запись сразу называлась «Созвон по биллингу»,
 * а не «Запись 27 августа», и участники были известны до диаризации.
 */

export interface CalendarEvent {
  id: string
  title: string
  startsAt: string
  endsAt: string
  participants: string[]
  location?: string | null
  notes?: string | null
  isNow: boolean
}

function helperPath(): string {
  const name = 'spyly-audiotap'
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'bin', name)]
    : [
        path.join(process.cwd(), 'native', 'macos-audio', '.build', 'release', name),
        path.join(app.getAppPath(), '..', '..', 'native', 'macos-audio', '.build', 'release', name)
      ]
  return candidates.find(existsSync) ?? candidates[0]!
}

function run(args: string[], env: Record<string, string> = {}, timeoutMs = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin' || !existsSync(helperPath())) {
      resolve({ code: -1, stdout: '', stderr: t('календарь доступен только на macOS') })
      return
    }
    const child = spawn(helperPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

export async function calendarGranted(): Promise<boolean> {
  const { code } = await run(['calendar-status'], {}, 4000)
  return code === 0
}

/** Запрос разрешения показывает системный диалог — ждём ответа дольше обычного. */
export async function requestCalendarAccess(): Promise<boolean> {
  const { code } = await run(['calendar-request'], {}, 70_000)
  return code === 0
}

export async function currentEvents(backMinutes = 20, forwardMinutes = 10): Promise<CalendarEvent[]> {
  const { stdout } = await run(['calendar-events'], {
    SPYLY_CAL_BACK: String(backMinutes),
    SPYLY_CAL_FORWARD: String(forwardMinutes)
  })
  try {
    return JSON.parse(stdout) as CalendarEvent[]
  } catch {
    return []
  }
}

/**
 * Событие, к которому вероятнее всего относится начинающаяся запись.
 *
 * Идущее сейчас важнее ближайшего будущего: если встреча уже началась,
 * записывают именно её.
 */
export async function likelyEvent(): Promise<CalendarEvent | null> {
  const events = await currentEvents()
  return events[0] ?? null
}

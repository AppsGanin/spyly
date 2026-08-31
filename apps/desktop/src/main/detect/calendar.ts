import { t } from '@spyly/core'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * Calendar events around the current moment.
 *
 * They are read by the native helper: Electron has no access to EventKit. The
 * calendar is there for exactly one thing, so that a recording is called
 * "Billing call" straight away rather than "Recording, 27 August", and the
 * participants are known before the conversation is processed.
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

/** Asking for access shows a system dialog, so wait longer than usual for an answer. */
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
 * Events that overlap a recording that has already happened.
 *
 * The helper only knows how to look around the present moment, so the window is
 * measured back from now and the result is narrowed to what actually touches the
 * recording. Half an hour either side: a meeting is rarely started to the minute.
 */
export async function eventsAround(startedAt: string, durationSec: number): Promise<CalendarEvent[]> {
  const start = new Date(startedAt).getTime()
  if (Number.isNaN(start)) return []
  const end = start + Math.max(0, durationSec) * 1000
  const slack = 30 * 60_000

  const back = Math.ceil((Date.now() - start + slack) / 60_000)
  const events = await currentEvents(Math.max(30, back), 30)

  return events.filter((event) => {
    const from = new Date(event.startsAt).getTime()
    const to = new Date(event.endsAt).getTime()
    if (Number.isNaN(from) || Number.isNaN(to)) return false
    return from <= end + slack && to >= start - slack
  })
}

/**
 * Writing a conversation that has already happened into the calendar.
 *
 * Returns the identifier of what was created, or the reason it failed: the
 * calendar can refuse for reasons of its own — an account gone read-only, no
 * calendar for new events at all — and silence there would look like a button
 * that does nothing.
 */
export async function createEvent(input: {
  title: string
  startsAt: string
  endsAt: string
  notes?: string
}): Promise<{ id: string } | { error: string }> {
  // Longer than a read: a calendar living in an account, rather than on the
  // machine, takes its time saving.
  const { code, stdout, stderr } = await run(
    ['calendar-create'],
    {
      SPYLY_CAL_TITLE: input.title,
      SPYLY_CAL_START: input.startsAt,
      SPYLY_CAL_END: input.endsAt,
      SPYLY_CAL_NOTES: input.notes ?? ''
    },
    25_000
  )
  if (code === 0) {
    try {
      const parsed = JSON.parse(stdout) as { id?: string }
      if (parsed.id) return { id: parsed.id }
    } catch {
      // falls through to the error below
    }
  }
  // The helper reports the reason as a line of JSON on stderr.
  for (const line of stderr.split('\n')) {
    try {
      const parsed = JSON.parse(line) as { type?: string; message?: string }
      if (parsed.type === 'error' && parsed.message) return { error: parsed.message }
    } catch {
      continue
    }
  }
  return { error: stderr.trim() || t('календарь не принял встречу') }
}

/**
 * The event a starting recording most likely belongs to.
 *
 * One happening now beats the nearest one ahead: if a meeting has already
 * begun, that is the one being recorded.
 */
export async function likelyEvent(): Promise<CalendarEvent | null> {
  const events = await currentEvents()
  return events[0] ?? null
}

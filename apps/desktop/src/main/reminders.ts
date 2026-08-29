import { Notification } from 'electron'
import { t, dueState, parseDue } from '@spyly/core'
import { listMeetingIds, readMeeting } from './store/meetings.js'
import { showMainWindow } from './index.js'

/**
 * Reminders about tasks with a deadline.
 *
 * A task said out loud gets lost even when it is written down: the task list
 * still has to be visited. Once a day we look for deadlines coming up and say
 * so ourselves, which is what the application is for.
 */
const HOUR = 3_600_000

let timer: NodeJS.Timeout | null = null
/** Which day we last reminded on: two notifications about the same thing annoy. */
let lastRunDay = ''

export function startReminders(): void {
  stopReminders()
  // The first check does not happen straight away: at startup a person is
  // looking at the screen anyway, and a notification over it is noise.
  // A reminder is a convenience and must not break: a damaged file in the
  // archive is no reason to spill unhandled rejections every hour.
  const safeCheck = () => void check().catch(() => undefined)
  timer = setInterval(safeCheck, HOUR)
  setTimeout(safeCheck, 60_000)
}

export function stopReminders(): void {
  if (timer) clearInterval(timer)
  timer = null
}

interface Pending {
  text: string
  meetingId: string
  meetingTitle: string
  state: 'overdue' | 'today'
}

/** Open tasks whose deadline is today or already past. */
export async function pendingTasks(now = new Date()): Promise<Pending[]> {
  const out: Pending[] = []
  for (const id of await listMeetingIds()) {
    const meeting = await readMeeting(id)
    for (const item of meeting?.summary?.actionItems ?? []) {
      if (item.done) continue
      const at = parseDue(item.due, now)
      if (!at) continue
      const state = dueState(at, now)
      if (state !== 'overdue' && state !== 'today') continue
      out.push({ text: item.text, meetingId: id, meetingTitle: meeting!.title, state })
    }
  }
  return out
}

async function check(): Promise<void> {
  const now = new Date()
  const day = now.toDateString()
  // Once a day and only during working hours: a task notification at night is
  // not care, it is a nuisance.
  if (day === lastRunDay || now.getHours() < 9 || now.getHours() > 21) return

  const pending = await pendingTasks(now)
  if (pending.length === 0) return
  lastRunDay = day

  if (!Notification.isSupported()) return
  const overdue = pending.filter((p) => p.state === 'overdue').length
  const first = pending[0]!
  const notification = new Notification({
    title: pending.length === 1 ? t('Задача ждёт') : t('Задач по срокам: {pending_length}', { pending_length: pending.length }),
    body:
      pending.length === 1
        ? first.text
        : `${first.text}${overdue > 0 ? t(' · просрочено: {overdue}', { overdue: overdue }) : ''}`,
    silent: true
  })
  // There is no task screen in the application: tasks live in the summaries of
  // recordings and in an agent's answers. We open the window; from there the
  // person goes to the recording they need.
  notification.on('click', () => showMainWindow())
  notification.show()
}

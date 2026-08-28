import { Notification } from 'electron'
import { t, dueState, parseDue } from '@spyly/core'
import { listMeetingIds, readMeeting } from './store/meetings.js'
import { showMainWindow } from './index.js'

/**
 * Напоминание о задачах со сроком.
 *
 * Задача, произнесённая голосом, теряется даже когда записана: в список задач
 * надо ещё зайти. Раз в день смотрим, не подошёл ли срок, и говорим об этом
 * сами — ради этого приложение и нужно.
 */
const HOUR = 3_600_000

let timer: NodeJS.Timeout | null = null
/** В какой день уже напоминали: два уведомления об одном и том же раздражают. */
let lastRunDay = ''

export function startReminders(): void {
  stopReminders()
  // Первую проверку делаем не сразу: при запуске приложения человек и так
  // смотрит на экран, а уведомление поверх него — шум.
  // Напоминание — удобство, и сорваться оно не должно: битый файл в архиве
  // не повод сыпать необработанными отказами каждый час.
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

/** Незакрытые задачи, у которых срок сегодня или уже прошёл. */
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
  // Раз в сутки и только в рабочее время: ночное уведомление о задаче — это
  // не забота, а помеха.
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
  // Экрана задач в приложении нет: задачи живут в конспектах записей и в
  // ответах агента. Открываем окно — дальше человек идёт в нужную запись.
  notification.on('click', () => showMainWindow())
  notification.show()
}

import { dueState, parseDue } from './due.js'
import type { ActionItem, Meeting } from './types.js'

/**
 * Итоги за период.
 *
 * Записей за неделю набирается десяток, и разобрать их по одной некогда.
 * Дайджест отвечает на три вопроса: на что ушло время, о чём договорились,
 * что осталось висеть. Считается из данных, без обращения к модели — иначе он
 * не работал бы у тех, у кого агент не подключён.
 */
export interface Digest {
  from: string
  to: string
  meetings: number
  seconds: number
  /** Люди и сколько раз с ними говорили. */
  people: { name: string; meetings: number }[]
  decisions: { text: string; meetingId: string; meetingTitle: string }[]
  open: (ActionItem & { meetingId: string; meetingTitle: string; overdue: boolean })[]
  done: number
  /** Записи без конспекта — их стоит добить. */
  unprocessed: { id: string; title: string }[]
  tags: { name: string; meetings: number }[]
}

function iso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function buildDigest(meetings: readonly Meeting[], from: Date, to: Date, now = new Date()): Digest {
  const inRange = meetings.filter((m) => {
    const at = Date.parse(m.startedAt)
    return at >= from.getTime() && at <= to.getTime()
  })

  const people = new Map<string, number>()
  const tags = new Map<string, number>()
  const decisions: Digest['decisions'] = []
  const open: Digest['open'] = []
  const unprocessed: Digest['unprocessed'] = []
  let seconds = 0
  let done = 0

  for (const meeting of inRange) {
    seconds += meeting.durationSec

    // Одного человека в одной записи считаем один раз: иначе болтливый
    // участник выглядел бы как несколько разных.
    const seen = new Set<string>()
    for (const speaker of meeting.speakers) {
      if (!speaker.name || speaker.isMe || seen.has(speaker.name)) continue
      seen.add(speaker.name)
      people.set(speaker.name, (people.get(speaker.name) ?? 0) + 1)
    }
    for (const name of meeting.calendarParticipants) {
      if (seen.has(name)) continue
      seen.add(name)
      people.set(name, (people.get(name) ?? 0) + 1)
    }

    for (const tag of meeting.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1)

    if (!meeting.summary) {
      if (meeting.utterances.length > 0) unprocessed.push({ id: meeting.id, title: meeting.title })
      continue
    }

    for (const text of meeting.summary.decisions) {
      decisions.push({ text, meetingId: meeting.id, meetingTitle: meeting.title })
    }
    for (const item of meeting.summary.actionItems) {
      if (item.done) {
        done++
        continue
      }
      open.push({
        ...item,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        overdue: dueState(parseDue(item.due, now) ?? undefined, now) === 'overdue'
      })
    }
  }

  return {
    from: iso(from),
    to: iso(to),
    meetings: inRange.length,
    seconds,
    people: [...people.entries()]
      .map(([name, count]) => ({ name, meetings: count }))
      .sort((a, b) => b.meetings - a.meetings),
    decisions,
    // Просроченное наверх: именно оно и есть повод открыть дайджест.
    open: open.sort((a, b) => Number(b.overdue) - Number(a.overdue)),
    done,
    unprocessed,
    tags: [...tags.entries()]
      .map(([name, count]) => ({ name, meetings: count }))
      .sort((a, b) => b.meetings - a.meetings)
  }
}

/** Границы периода «последние N дней, включая сегодня». */
export function lastDays(days: number, now = new Date()): { from: Date; to: Date } {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  const from = new Date(to.getTime() - (days - 1) * 86_400_000)
  from.setHours(0, 0, 0, 0)
  return { from, to }
}

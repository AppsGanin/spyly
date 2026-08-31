import { dueState, parseDue } from './due.js'
import type { ActionItem, Meeting } from './types.js'

/**
 * A digest for a period.
 *
 * A week brings a dozen recordings, and there is no time to go through them one
 * by one. The digest answers three questions: where the time went, what was
 * agreed, and what is still outstanding. It is computed from the data, with no
 * model involved, or it would not work for anyone without an agent connected.
 */
export interface Digest {
  from: string
  to: string
  meetings: number
  seconds: number
  /** People, and how many times you spoke with them. */
  people: { name: string; meetings: number }[]
  decisions: { text: string; meetingId: string; meetingTitle: string }[]
  open: (ActionItem & { meetingId: string; meetingTitle: string; overdue: boolean })[]
  done: number
  /** Recordings with no summary: worth finishing off. */
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

    // Names come from the calendar: the transcript itself knows only "you" and
    // "the other side", and guessing who that was by voice was removed.
    const seen = new Set<string>()
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
    // Overdue on top: that is the very reason to open a digest.
    open: open.sort((a, b) => Number(b.overdue) - Number(a.overdue)),
    done,
    unprocessed,
    tags: [...tags.entries()]
      .map(([name, count]) => ({ name, meetings: count }))
      .sort((a, b) => b.meetings - a.meetings)
  }
}

/** The bounds of the period "the last N days, today included". */
export function lastDays(days: number, now = new Date()): { from: Date; to: Date } {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  const from = new Date(to.getTime() - (days - 1) * 86_400_000)
  from.setHours(0, 0, 0, 0)
  return { from, to }
}

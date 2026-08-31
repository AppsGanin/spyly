import { speakerLabel } from '@spyly/core'
import type { Meeting, MeetingMeta, Utterance } from '@spyly/core'

/**
 * Parsing and filtering recordings.
 *
 * It lives apart from the protocol because the same filters are used by the
 * search inside the application: the rules for "this week", "unprocessed" and
 * "what Maria said" have to agree everywhere.
 */

/** The processing state, what a person asks about as "unprocessed". */
export type MeetingStatus = 'done' | 'processing' | 'failed' | 'no-transcript' | 'no-summary'

export interface MeetingFilter {
  /** The start of the period: an ISO date or a word such as "today" or "week". */
  since?: string
  until?: string
  status?: MeetingStatus
  /** A participant: the whole name or part of it. */
  speaker?: string
  limit?: number
}

const DAY = 86_400_000

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * Understanding dates the way people say them.
 *
 * The agent gets a request in words ("what happened this week"), and demanding
 * ISO dates from it is one more chance to get it wrong.
 */
export function parseWhen(input: string | undefined, now = new Date()): Date | null {
  if (!input) return null
  const text = input.trim().toLowerCase()
  if (!text) return null

  const today = startOfDay(now)

  const words: Record<string, number> = {
    'сегодня': 0,
    'today': 0,
    'вчера': 1,
    'yesterday': 1,
    'позавчера': 2,
    'неделя': 7,
    'неделю': 7,
    'week': 7,
    'месяц': 30,
    'month': 30,
    'квартал': 90,
    'quarter': 90,
    'год': 365,
    'year': 365
  }
  for (const [word, days] of Object.entries(words)) {
    if (text.includes(word)) return new Date(today.getTime() - days * DAY)
  }

  // The spoken forms "3 days" and "5 days".
  const relative = /(\d+)\s*(дн|day|недел|week|месяц|month)/.exec(text)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2] ?? ''
    const multiplier = unit.startsWith('недел') || unit.startsWith('week') ? 7 : unit.startsWith('месяц') || unit.startsWith('month') ? 30 : 1
    return new Date(today.getTime() - amount * multiplier * DAY)
  }

  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : new Date(parsed)
}

/** What state a recording's processing is in. */
export function meetingStatus(meeting: Pick<Meeting, 'stages' | 'utterances' | 'summary'>): MeetingStatus {
  const stages = meeting.stages ?? {}
  if (Object.values(stages).includes('running')) return 'processing'
  if (stages.transcribing === 'failed') return 'failed'
  if ((meeting.utterances?.length ?? 0) === 0) return 'no-transcript'
  if (!meeting.summary) return 'no-summary'
  return 'done'
}

export function matchesFilter(meeting: Meeting, filter: MeetingFilter, now = new Date()): boolean {
  const at = Date.parse(meeting.startedAt)
  const since = parseWhen(filter.since, now)
  const until = parseWhen(filter.until, now)
  if (since && at < since.getTime()) return false
  // The upper bound covers the whole of the day given.
  if (until && at > until.getTime() + DAY) return false
  if (filter.status && meetingStatus(meeting) !== filter.status) return false

  if (filter.speaker) {
    // The transcript knows two sides and no names; who was on the other end is
    // known only from the calendar, so that is what a name is matched against.
    const needle = filter.speaker.toLowerCase()
    const found = meeting.calendarParticipants.some((name) => name.toLowerCase().includes(needle))
    if (!found) return false
  }
  return true
}

export interface Hit {
  utterance: Utterance
  speaker: string
}

/** Matches inside one recording, with the speaker's name. */
export function findInMeeting(meeting: Meeting, query: string, speaker?: string): Hit[] {
  const needle = query.trim().toLowerCase()
  const names = new Map(meeting.speakers.map((s) => [s.id, speakerLabel(s, s.id)]))
  const speakerNeedle = speaker?.toLowerCase()

  return meeting.utterances
    .filter((u) => {
      if (needle && !u.text.toLowerCase().includes(needle)) return false
      if (speakerNeedle) {
        const name = (names.get(u.speakerId) ?? '').toLowerCase()
        if (!name.includes(speakerNeedle)) return false
      }
      return true
    })
    .map((u) => ({ utterance: u, speaker: names.get(u.speakerId) ?? u.speakerId }))
}

/** A short card of a recording for the answer to an agent. */
export function summarize(meeting: Meeting): {
  id: string
  title: string
  startedAt: string
  durationSec: number
  status: MeetingStatus
  participants: string[]
  tldr?: string
} {
  return {
    id: meeting.id,
    title: meeting.title,
    startedAt: meeting.startedAt,
    durationSec: Math.round(meeting.durationSec),
    status: meetingStatus(meeting),
    participants: [...new Set(meeting.speakers.map((s) => speakerLabel(s, s.id)))],
    tldr: meeting.summary?.tldr
  }
}

export function metaOf(meeting: Meeting): MeetingMeta {
  const { speakers, utterances, summary, ...meta } = meeting
  return meta
}

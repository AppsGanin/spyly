import type { Meeting, MeetingMeta, Utterance } from '@spyly/core'

/**
 * Разбор и фильтрация записей.
 *
 * Живёт отдельно от протокола, потому что теми же фильтрами пользуется и
 * поиск внутри приложения: правила «за неделю», «необработанные», «что
 * говорила Мария» должны совпадать везде.
 */

/** Состояние обработки — то, что человек спрашивает как «необработанные». */
export type MeetingStatus = 'done' | 'processing' | 'failed' | 'no-transcript' | 'no-summary'

export interface MeetingFilter {
  /** Начало периода: ISO-дата или слово вроде «сегодня», «неделя». */
  since?: string
  until?: string
  status?: MeetingStatus
  /** Участник: имя целиком или его часть. */
  speaker?: string
  limit?: number
}

const DAY = 86_400_000

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * Понимание дат «по-человечески».
 *
 * Агент получает запрос словами («что было на этой неделе»), и требовать от
 * него ISO-даты — лишний повод ошибиться.
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
    'год': 365,
    'year': 365
  }
  for (const [word, days] of Object.entries(words)) {
    if (text.includes(word)) return new Date(today.getTime() - days * DAY)
  }

  // «за 3 дня», «5 days»
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

/** В каком состоянии обработка записи. */
export function meetingStatus(meeting: Pick<Meeting, 'stages' | 'utterances' | 'summary'>): MeetingStatus {
  const stages = meeting.stages ?? {}
  if (Object.values(stages).includes('running')) return 'processing'
  if (stages.transcribing === 'failed' || stages.diarizing === 'failed') return 'failed'
  if ((meeting.utterances?.length ?? 0) === 0) return 'no-transcript'
  if (!meeting.summary) return 'no-summary'
  return 'done'
}

export function matchesFilter(meeting: Meeting, filter: MeetingFilter, now = new Date()): boolean {
  const at = Date.parse(meeting.startedAt)
  const since = parseWhen(filter.since, now)
  const until = parseWhen(filter.until, now)
  if (since && at < since.getTime()) return false
  // Верхняя граница включает весь указанный день.
  if (until && at > until.getTime() + DAY) return false
  if (filter.status && meetingStatus(meeting) !== filter.status) return false

  if (filter.speaker) {
    const needle = filter.speaker.toLowerCase()
    const found = meeting.speakers.some((s) => (s.name ?? '').toLowerCase().includes(needle))
    if (!found) return false
  }
  return true
}

export interface Hit {
  utterance: Utterance
  speaker: string
}

/** Совпадения внутри одной записи, с именем говорящего. */
export function findInMeeting(meeting: Meeting, query: string, speaker?: string): Hit[] {
  const needle = query.trim().toLowerCase()
  const names = new Map(meeting.speakers.map((s) => [s.id, s.name ?? (s.isMe ? 'Вы' : s.id)]))
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

/** Краткая карточка записи для ответа агенту. */
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
    participants: [...new Set(meeting.speakers.map((s) => s.name ?? (s.isMe ? 'Вы' : `Участник ${s.cluster + 1}`)))],
    tldr: meeting.summary?.tldr
  }
}

export function metaOf(meeting: Meeting): MeetingMeta {
  const { speakers, utterances, summary, ...meta } = meeting
  return meta
}

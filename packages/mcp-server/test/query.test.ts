import { describe, expect, it } from 'vitest'
import { findInMeeting, matchesFilter, meetingStatus, parseWhen } from '../src/query.js'
import type { Meeting } from '@spyly/core'

const NOW = new Date('2026-08-27T12:00:00.000Z')

const meeting = (patch: Partial<Meeting> = {}): Meeting =>
  ({
    id: 'm1',
    title: 'Про биллинг',
    kind: 'work',
    startedAt: '2026-08-27T10:00:00.000Z',
    durationSec: 600,
    language: 'ru',
    sources: { mic: true, system: true },
    stages: { recording: 'done', transcribing: 'done', diarizing: 'done' },
    errors: {},
    providers: {},
    notes: '',
    tags: [],
    speakers: [
      { id: 'mic:0', track: 'mic', cluster: 0, name: 'Дима', isMe: true, nameSource: 'manual' },
      { id: 'system:0', track: 'system', cluster: 0, name: 'Мария', isMe: false, nameSource: 'manual' }
    ],
    utterances: [
      { id: 'u1', speakerId: 'mic:0', track: 'mic', start: 0, end: 3, text: 'Нам нужно переделать биллинг', words: [], provisional: false },
      { id: 'u2', speakerId: 'system:0', track: 'system', start: 4, end: 8, text: 'Согласна, возьму миграцию', words: [], provisional: false }
    ],
    ...patch
  }) as Meeting

/** Period bounds are computed by the local day: a person thinks in their own time zone. */
const localDay = (date: Date | null): string =>
  date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    : ''

describe('parseWhen', () => {
  it('understands words', () => {
    expect(localDay(parseWhen('сегодня', NOW))).toBe('2026-08-27')
    expect(localDay(parseWhen('вчера', NOW))).toBe('2026-08-26')
    expect(localDay(parseWhen('неделя', NOW))).toBe('2026-08-20')
  })
  it('understands "N days"', () => {
    expect(localDay(parseWhen('за 3 дня', NOW))).toBe('2026-08-24')
    expect(localDay(parseWhen('2 недели', NOW))).toBe('2026-08-13')
  })
  it('a period starts at midnight of the local day, not at the moment of the query', () => {
    const since = parseWhen('сегодня', NOW)!
    expect(since.getHours()).toBe(0)
    expect(since.getMinutes()).toBe(0)
  })
  it('understands ISO', () => {
    expect(parseWhen('2026-08-01', NOW)?.toISOString().slice(0, 10)).toBe('2026-08-01')
  })
  it('on rubbish it returns null', () => {
    expect(parseWhen('когда-нибудь', NOW)).toBeNull()
    expect(parseWhen('', NOW)).toBeNull()
    expect(parseWhen(undefined, NOW)).toBeNull()
  })
})

describe('meetingStatus', () => {
  it('tells the states apart', () => {
    expect(meetingStatus(meeting())).toBe('no-summary')
    expect(meetingStatus(meeting({ utterances: [] }))).toBe('no-transcript')
    expect(meetingStatus(meeting({ stages: { transcribing: 'running' } }))).toBe('processing')
    expect(meetingStatus(meeting({ stages: { transcribing: 'failed' } }))).toBe('failed')
  })
})

describe('matchesFilter', () => {
  it('filters by period', () => {
    expect(matchesFilter(meeting(), { since: 'сегодня' }, NOW)).toBe(true)
    expect(matchesFilter(meeting({ startedAt: '2026-08-01T10:00:00.000Z' }), { since: 'неделя' }, NOW)).toBe(false)
  })
  it('filters by state', () => {
    expect(matchesFilter(meeting(), { status: 'no-summary' }, NOW)).toBe(true)
    expect(matchesFilter(meeting(), { status: 'done' }, NOW)).toBe(false)
  })
  it('filters by participant', () => {
    expect(matchesFilter(meeting(), { speaker: 'мари' }, NOW)).toBe(true)
    expect(matchesFilter(meeting(), { speaker: 'Пётр' }, NOW)).toBe(false)
  })
})

describe('findInMeeting', () => {
  it('finds utterances by text', () => {
    const hits = findInMeeting(meeting(), 'биллинг')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.speaker).toBe('Дима')
  })
  it('narrows by participant', () => {
    expect(findInMeeting(meeting(), '', 'Мария')).toHaveLength(1)
  })
  it('an empty query with no participant returns everything', () => {
    expect(findInMeeting(meeting(), '')).toHaveLength(2)
  })
})

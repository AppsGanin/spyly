import { describe, expect, it } from 'vitest'
import { buildDigest, lastDays } from '../src/digest.js'
import { Meeting } from '../src/types.js'
import type { ActionItem, Summary } from '../src/types.js'

const now = new Date(2026, 8, 3, 15, 0, 0)

function meeting(
  id: string,
  daysAgo: number,
  options: { summary?: Partial<Summary>; people?: string[]; tags?: string[]; utterances?: number } = {}
): Meeting {
  const at = new Date(now.getTime() - daysAgo * 86_400_000)
  const summary: Summary | undefined = options.summary
    ? {
        tldr: '',
        keyPoints: [],
        decisions: [],
        actionItems: [],
        questions: [],
        generatedAt: at.toISOString(),
        ...options.summary
      }
    : undefined

  return Meeting.parse({
    id,
    title: id,
    kind: 'work',
    startedAt: at.toISOString(),
    durationSec: 600,
    language: 'ru',
    sources: { mic: true, system: true },
    marks: [],
    tags: options.tags ?? [],
    calendarParticipants: options.people ?? [],
    stages: {},
    errors: {},
    speakers: [],
    utterances: Array.from({ length: options.utterances ?? 1 }, (_, i) => ({
      id: `${id}-${i}`,
      speakerId: 'local:0',
      track: 'mic' as const,
      start: i,
      end: i + 1,
      text: 'реплика',
      words: [],
      provisional: false
    })),
    summary
  })
}

const task = (text: string, extra: Partial<ActionItem> = {}): ActionItem => ({
  text,
  done: false,
  ...extra
})

describe('buildDigest', () => {
  const { from, to } = lastDays(7, now)

  it('считает только записи внутри периода', () => {
    const digest = buildDigest([meeting('свежая', 1), meeting('старая', 30)], from, to, now)
    expect(digest.meetings).toBe(1)
    expect(digest.seconds).toBe(600)
  })

  it('собирает решения со ссылкой на разговор', () => {
    const digest = buildDigest(
      [meeting('a', 1, { summary: { decisions: ['переходим на новый биллинг'] } })],
      from,
      to,
      now
    )
    expect(digest.decisions).toEqual([
      { text: 'переходим на новый биллинг', meetingId: 'a', meetingTitle: 'a' }
    ])
  })

  it('открытые задачи отделяет от сделанных, просроченные ставит первыми', () => {
    const digest = buildDigest(
      [
        meeting('a', 1, {
          summary: {
            actionItems: [
              task('сделанная', { done: true }),
              task('обычная'),
              task('горит', { due: '2026-09-01' })
            ]
          }
        })
      ],
      from,
      to,
      now
    )
    expect(digest.done).toBe(1)
    expect(digest.open.map((t) => t.text)).toEqual(['горит', 'обычная'])
    expect(digest.open[0]!.overdue).toBe(true)
  })

  it('считает людей по числу разговоров, а не реплик', () => {
    const digest = buildDigest(
      [meeting('a', 1, { people: ['Мария'] }), meeting('b', 2, { people: ['Мария', 'Пётр'] })],
      from,
      to,
      now
    )
    expect(digest.people).toEqual([
      { name: 'Мария', meetings: 2 },
      { name: 'Пётр', meetings: 1 }
    ])
  })

  it('замечает записи без конспекта', () => {
    const digest = buildDigest([meeting('без конспекта', 1)], from, to, now)
    expect(digest.unprocessed).toEqual([{ id: 'без конспекта', title: 'без конспекта' }])
  })

  it('запись без расшифровки недоделанной не считает', () => {
    // An empty recording is just audio that has not been processed yet; there is
    // nothing to reproach a person for.
    const digest = buildDigest([meeting('пустая', 1, { utterances: 0 })], from, to, now)
    expect(digest.unprocessed).toHaveLength(0)
  })
})

describe('lastDays', () => {
  it('семь дней включают сегодня', () => {
    const { from, to } = lastDays(7, now)
    expect(from.getDate()).toBe(28)
    expect(to.getDate()).toBe(3)
  })
})

import { describe, expect, it } from 'vitest'
import { meetingTerms, relatedMeetings } from '../src/relate.js'
import { Meeting } from '../src/types.js'

function meeting(id: string, lines: string[], people: string[] = []): Meeting {
  return Meeting.parse({
    id,
    title: id,
    kind: 'work',
    startedAt: '2026-08-27T10:00:00.000Z',
    durationSec: 600,
    language: 'ru',
    sources: { mic: true, system: true },
    marks: [],
    tags: [],
    calendarParticipants: people,
    stages: {},
    errors: {},
    speakers: people.map((name, index) => ({
      id: `local:${index}`,
      cluster: index,
      track: 'mic' as const,
      name,
      isMe: false,
      nameSource: 'manual' as const
    })),
    utterances: lines.map((text, index) => ({
      id: `${id}-${index}`,
      speakerId: 'local:0',
      track: 'mic' as const,
      start: index * 10,
      end: index * 10 + 9,
      text,
      words: [],
      provisional: false
    }))
  })
}

// Каждое характерное слово должно прозвучать дважды: одиночные отбрасываются
// как вероятная ослышка распознавателя.
const billing = [
  'обсудили биллинг и тарификацию подписок',
  'биллинг надо переделать, тарификация подписок сломана',
  'миграция базы для биллинга запланирована'
]
const billingAgain = [
  'вернулись к биллингу и тарификации',
  'биллинг и тарификация подписок: миграция базы',
  'подписок стало больше, миграция затянулась'
]
const design = [
  'обсудили макеты и типографику интерфейса',
  'макеты интерфейса готовы, типографику поправим',
  'иллюстрации для лендинга заказали'
]

describe('relatedMeetings', () => {
  it('находит продолжение разговора по общим словам', () => {
    const current = meeting('billing-1', billing)
    const related = relatedMeetings(current, [meeting('billing-2', billingAgain), meeting('design-1', design)])
    expect(related.map((r) => r.meeting.id)).toEqual(['billing-2'])
    expect(related[0]!.sharedTerms).toContain('биллинг')
  })

  it('не связывает разговоры на разные темы', () => {
    const related = relatedMeetings(meeting('design-1', design), [meeting('billing-1', billing)])
    expect(related).toHaveLength(0)
  })

  it('себя в похожие не записывает', () => {
    const current = meeting('billing-1', billing)
    expect(relatedMeetings(current, [current])).toHaveLength(0)
  })

  it('общие участники усиливают связь', () => {
    const current = meeting('billing-1', billing, ['Мария', 'Пётр'])
    const withPeople = relatedMeetings(current, [meeting('billing-2', billingAgain, ['Мария', 'Пётр'])])
    const without = relatedMeetings(current, [meeting('billing-2', billingAgain)])
    expect(withPeople[0]!.score).toBeGreaterThan(without[0]!.score)
    expect(withPeople[0]!.sharedPeople).toContain('мария')
  })
})

describe('meetingTerms', () => {
  it('выкидывает слова-связки', () => {
    const terms = meetingTerms(meeting('x', ['просто вот это надо сделать', 'просто вот это надо сделать']))
    expect([...terms.values()]).not.toContain('просто')
    expect([...terms.values()]).toContain('сделать')
  })

  it('разные формы одного слова считает за одно', () => {
    const terms = meetingTerms(meeting('x', ['биллинг сломался', 'в биллинге ошибка', 'чиним биллинга']))
    const forms = [...terms.values()].filter((w) => w.startsWith('биллинг'))
    expect(forms).toHaveLength(1)
  })

  it('на длинном разговоре одиночные слова отбрасывает', () => {
    // Восемь повторяющихся слов — этого достаточно, чтобы не брать всё подряд.
    const lines = Array.from({ length: 4 }, () => 'релиз миграция биллинг тестирование деплой конфигурация мониторинг документация')
    const terms = meetingTerms(meeting('x', [...lines, 'кубернетес упал однажды']))
    expect([...terms.values()]).not.toContain('кубернетес')
    expect([...terms.values()]).toContain('релиз')
  })
})

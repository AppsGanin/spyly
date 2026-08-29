import { describe, expect, it } from 'vitest'
import { dueState, parseDue } from '../src/due.js'

// A Thursday, so that "Friday" and "the end of the week" are tomorrow rather than a week away.
const thursday = new Date(2026, 8, 3, 15, 0, 0)

describe('parseDue', () => {
  it('понимает завтра и послезавтра', () => {
    expect(parseDue('завтра', thursday)).toBe('2026-09-04')
    expect(parseDue('послезавтра', thursday)).toBe('2026-09-05')
  })

  it('конец недели — это пятница, а не воскресенье', () => {
    expect(parseDue('до конца недели', thursday)).toBe('2026-09-04')
  })

  it('в пятницу, когда сегодня четверг, — завтра', () => {
    expect(parseDue('в пятницу', thursday)).toBe('2026-09-04')
  })

  it('день недели, который уже прошёл, — на следующей неделе', () => {
    expect(parseDue('во вторник', thursday)).toBe('2026-09-08')
  })

  it('разбирает число с месяцем', () => {
    expect(parseDue('до 15 сентября', thursday)).toBe('2026-09-15')
  })

  it('месяц, который давно прошёл, относит к следующему году', () => {
    expect(parseDue('10 января', thursday)).toBe('2027-01-10')
  })

  it('считает «через N»', () => {
    expect(parseDue('через 3 дня', thursday)).toBe('2026-09-06')
    expect(parseDue('через неделю', thursday)).toBe('2026-09-10')
  })

  it('конец месяца — последнее его число', () => {
    expect(parseDue('до конца месяца', thursday)).toBe('2026-09-30')
  })

  it('готовую дату принимает как есть', () => {
    expect(parseDue('2026-12-01', thursday)).toBe('2026-12-01')
  })

  it('незнакомое выражение не превращает в дату', () => {
    // An invented deadline is worse than one that was never found: a reminder will arrive for it.
    expect(parseDue('как получится', thursday)).toBeNull()
    expect(parseDue('', thursday)).toBeNull()
    expect(parseDue(undefined, thursday)).toBeNull()
  })
})

describe('dueState', () => {
  it('различает просрочено, сегодня и скоро', () => {
    expect(dueState('2026-09-02', thursday)).toBe('overdue')
    expect(dueState('2026-09-03', thursday)).toBe('today')
    expect(dueState('2026-09-05', thursday)).toBe('soon')
    expect(dueState('2026-10-01', thursday)).toBe('later')
  })

  it('без срока состояния нет', () => {
    expect(dueState(undefined, thursday)).toBe('none')
    expect(dueState('когда-нибудь', thursday)).toBe('none')
  })
})

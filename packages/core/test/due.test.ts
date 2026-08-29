import { describe, expect, it } from 'vitest'
import { dueState, parseDue } from '../src/due.js'

// A Thursday, so that "Friday" and "the end of the week" are tomorrow rather than a week away.
const thursday = new Date(2026, 8, 3, 15, 0, 0)

describe('parseDue', () => {
  it('understands tomorrow and the day after', () => {
    expect(parseDue('завтра', thursday)).toBe('2026-09-04')
    expect(parseDue('послезавтра', thursday)).toBe('2026-09-05')
  })

  it('the end of the week is Friday, not Sunday', () => {
    expect(parseDue('до конца недели', thursday)).toBe('2026-09-04')
  })

  it('on Friday, when today is Thursday, means tomorrow', () => {
    expect(parseDue('в пятницу', thursday)).toBe('2026-09-04')
  })

  it('a weekday that has passed means next week', () => {
    expect(parseDue('во вторник', thursday)).toBe('2026-09-08')
  })

  it('parses a day with a month', () => {
    expect(parseDue('до 15 сентября', thursday)).toBe('2026-09-15')
  })

  it('a month long past belongs to next year', () => {
    expect(parseDue('10 января', thursday)).toBe('2027-01-10')
  })

  it('counts "in N"', () => {
    expect(parseDue('через 3 дня', thursday)).toBe('2026-09-06')
    expect(parseDue('через неделю', thursday)).toBe('2026-09-10')
  })

  it('the end of the month is its last day', () => {
    expect(parseDue('до конца месяца', thursday)).toBe('2026-09-30')
  })

  it('a ready-made date is taken as it is', () => {
    expect(parseDue('2026-12-01', thursday)).toBe('2026-12-01')
  })

  it('an unfamiliar expression does not become a date', () => {
    // An invented deadline is worse than one that was never found: a reminder will arrive for it.
    expect(parseDue('как получится', thursday)).toBeNull()
    expect(parseDue('', thursday)).toBeNull()
    expect(parseDue(undefined, thursday)).toBeNull()
  })
})

describe('dueState', () => {
  it('tells overdue, today and soon apart', () => {
    expect(dueState('2026-09-02', thursday)).toBe('overdue')
    expect(dueState('2026-09-03', thursday)).toBe('today')
    expect(dueState('2026-09-05', thursday)).toBe('soon')
    expect(dueState('2026-10-01', thursday)).toBe('later')
  })

  it('with no deadline there is no state', () => {
    expect(dueState(undefined, thursday)).toBe('none')
    expect(dueState('когда-нибудь', thursday)).toBe('none')
  })
})

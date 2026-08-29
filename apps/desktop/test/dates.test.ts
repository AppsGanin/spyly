import { describe, expect, it } from 'vitest'
import { setLang } from '@spyly/core'
import { dayLabel, fullDateLabel, timeLabel } from '../src/renderer/src/lib/dates'

/**
 * There was infinite recursion here: the locale helper called itself, and the
 * application died with "Maximum call stack size exceeded" on the very first
 * screen.
 */
describe('date captions', () => {
  const iso = new Date().toISOString()

  for (const lang of ['ru', 'en'] as const) {
    it(`не уходят в рекурсию на языке «${lang}»`, () => {
      setLang(lang)
      expect(() => dayLabel(iso)).not.toThrow()
      expect(() => timeLabel(iso)).not.toThrow()
      expect(() => fullDateLabel(iso)).not.toThrow()
      expect(dayLabel(iso).length).toBeGreaterThan(0)
    })
  }

  it('today is named in the interface language', () => {
    setLang('ru')
    expect(dayLabel(iso)).toBe('Сегодня')
    setLang('en')
    expect(dayLabel(iso)).toBe('Today')
    setLang('ru')
  })

  it('a distant date does not break', () => {
    setLang('en')
    expect(() => dayLabel('2020-01-05T10:00:00.000Z')).not.toThrow()
    setLang('ru')
  })

  it('a broken date does not bring the caption down', () => {
    expect(dayLabel('не дата')).toBe('Когда-то')
  })
})

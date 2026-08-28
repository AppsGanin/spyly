import { describe, expect, it } from 'vitest'
import { setLang } from '@spyly/core'
import { dayLabel, fullDateLabel, timeLabel } from '../src/renderer/src/lib/dates'

/**
 * Здесь была бесконечная рекурсия: вспомогательная функция выбора локали
 * вызывала саму себя, и приложение падало с «Maximum call stack size exceeded»
 * на самом первом экране.
 */
describe('подписи дат', () => {
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

  it('сегодняшний день называется по языку', () => {
    setLang('ru')
    expect(dayLabel(iso)).toBe('Сегодня')
    setLang('en')
    expect(dayLabel(iso)).toBe('Today')
    setLang('ru')
  })

  it('давняя дата не ломается', () => {
    setLang('en')
    expect(() => dayLabel('2020-01-05T10:00:00.000Z')).not.toThrow()
    setLang('ru')
  })

  it('битая дата не роняет подпись', () => {
    expect(dayLabel('не дата')).toBe('Когда-то')
  })
})

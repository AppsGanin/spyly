import { describe, expect, it } from 'vitest'
import { stripHallucination, isLikelyHallucination } from '../src/hallucination.js'

describe('isLikelyHallucination', () => {
  it('catches Russian subtitle credits', () => {
    expect(isLikelyHallucination('Редактор субтитров А.Семкин Корректор А.Егорова')).toBe(true)
    expect(isLikelyHallucination('Продолжение следует...')).toBe(true)
    expect(isLikelyHallucination('Субтитры сделал DimaTorzok')).toBe(true)
    expect(isLikelyHallucination('Спасибо за просмотр')).toBe(true)
    expect(isLikelyHallucination('Подписывайтесь на канал!')).toBe(true)
  })

  it('catches English subtitle sign-offs', () => {
    expect(isLikelyHallucination('Thanks for watching!')).toBe(true)
    expect(isLikelyHallucination('Subtitles by the Amara.org community')).toBe(true)
    expect(isLikelyHallucination('[Music]')).toBe(true)
  })

  it('catches empty and one-word fillers', () => {
    expect(isLikelyHallucination('')).toBe(true)
    expect(isLikelyHallucination('  ...  ')).toBe(true)
    expect(isLikelyHallucination('you')).toBe(true)
  })

  it('catches a stuck repeat of one word', () => {
    expect(isLikelyHallucination('да да да да да да да')).toBe(true)
  })

  it('leaves real speech alone', () => {
    expect(isLikelyHallucination('Нам нужно переделать расчёт подписок до конца недели')).toBe(false)
    expect(isLikelyHallucination('Да, согласен')).toBe(false)
    expect(isLikelyHallucination('Спасибо, я посмотрю отчёт и вернусь с правками')).toBe(false)
  })

  it('does not call a fair mention of subtitles invented', () => {
    expect(isLikelyHallucination('Давай добавим субтитры в плеер на следующей неделе')).toBe(false)
  })
})

// A curated dictionary: credits are looked for as substrings, sign-offs only whole.
describe('the dictionary of inventions', () => {
  it('catches subtitle author credits anywhere in the string', () => {
    for (const text of [
      'Субтитры сделал DimaTorzok',
      'Продолжение. Субтитры создал Алексей Дубровский',
      'Subtitles by the Amara.org community',
      'Altyazı M.K.',
      'Untertitel der Amara.org-Community'
    ]) {
      expect(isLikelyHallucination(text), text).toBe(true)
    }
  })

  it('video sign-offs are cut only whole', () => {
    expect(isLikelyHallucination('Спасибо за просмотр')).toBe(true)
    expect(isLikelyHallucination('Thank you')).toBe(true)
    // The same phrase inside a live utterance is real speech and must not be touched.
    expect(isLikelyHallucination('Спасибо за просмотр этой страницы, я всё понял')).toBe(false)
    expect(isLikelyHallucination('Thank you for sending the file, I got it')).toBe(false)
  })

  it('the word "proofreader" in live speech is not a credit', () => {
    // It is in the list as a credit, but catching it as a substring will not do.
    expect(isLikelyHallucination('нам нужен корректор в команду')).toBe(false)
    expect(isLikelyHallucination('Корректор А.Егорова')).toBe(true)
  })

  it('leaves ordinary utterances alone', () => {
    for (const text of [
      'Привет, нам нужно переделать расчёт подписок',
      'Я возьму на себя миграцию базы данных',
      'Спасибо, я посмотрю и отпишусь завтра'
    ]) {
      expect(isLikelyHallucination(text), text).toBe(false)
    }
  })
})

/**
 * Subtitle credits stick to the edge of an utterance. They used to drag all the
 * live speech away with them: on a real recording "Subtitles by DimaTorzok"
 * carried off thirty-seven seconds of conversation.
 */
describe('cutting a credit out of an utterance', () => {
  it('removes the credit and keeps the speech', () => {
    expect(
      stripHallucination('Субтитры делал DimaTorzok Если его весь можно разместить на поверхность.')
    ).toBe('Если его весь можно разместить на поверхность.')
  })

  it('a credit with no speech is removed whole', () => {
    expect(stripHallucination('Субтитры сделал DimaTorzok')).toBeNull()
    expect(stripHallucination('Subtitles by the Amara.org community')).toBeNull()
  })

  it('leaves live speech alone', () => {
    const text = 'надо обсудить биллинг и сроки по релизу'
    expect(stripHallucination(text)).toBe(text)
  })

  it('a credit at the end is removed too', () => {
    expect(stripHallucination('Обсудили сроки по релизу. Субтитры сделал DimaTorzok')).toBe(
      'Обсудили сроки по релизу.'
    )
  })

  it('an empty string gives nothing', () => {
    expect(stripHallucination('   ')).toBeNull()
  })
})

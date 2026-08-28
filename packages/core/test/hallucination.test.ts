import { describe, expect, it } from 'vitest'
import { stripHallucination, isLikelyHallucination } from '../src/hallucination.js'

describe('isLikelyHallucination', () => {
  it('ловит титры русских субтитров', () => {
    expect(isLikelyHallucination('Редактор субтитров А.Семкин Корректор А.Егорова')).toBe(true)
    expect(isLikelyHallucination('Продолжение следует...')).toBe(true)
    expect(isLikelyHallucination('Субтитры сделал DimaTorzok')).toBe(true)
    expect(isLikelyHallucination('Спасибо за просмотр')).toBe(true)
    expect(isLikelyHallucination('Подписывайтесь на канал!')).toBe(true)
  })

  it('ловит английские субтитровые хвосты', () => {
    expect(isLikelyHallucination('Thanks for watching!')).toBe(true)
    expect(isLikelyHallucination('Subtitles by the Amara.org community')).toBe(true)
    expect(isLikelyHallucination('[Music]')).toBe(true)
  })

  it('ловит пустое и односложные затычки', () => {
    expect(isLikelyHallucination('')).toBe(true)
    expect(isLikelyHallucination('  ...  ')).toBe(true)
    expect(isLikelyHallucination('you')).toBe(true)
  })

  it('ловит залипший повтор одного слова', () => {
    expect(isLikelyHallucination('да да да да да да да')).toBe(true)
  })

  it('не трогает настоящую речь', () => {
    expect(isLikelyHallucination('Нам нужно переделать расчёт подписок до конца недели')).toBe(false)
    expect(isLikelyHallucination('Да, согласен')).toBe(false)
    expect(isLikelyHallucination('Спасибо, я посмотрю отчёт и вернусь с правками')).toBe(false)
  })

  it('не считает выдумкой упоминание субтитров по делу', () => {
    expect(isLikelyHallucination('Давай добавим субтитры в плеер на следующей неделе')).toBe(false)
  })
})

// Курируемый словарь: подписи ищутся подстрокой, концовки — только целиком.
describe('словарь выдумок', () => {
  it('ловит подписи авторов субтитров где угодно в строке', () => {
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

  it('концовки роликов режет только целиком', () => {
    expect(isLikelyHallucination('Спасибо за просмотр')).toBe(true)
    expect(isLikelyHallucination('Thank you')).toBe(true)
    // Та же фраза внутри живой реплики — настоящая речь, её трогать нельзя.
    expect(isLikelyHallucination('Спасибо за просмотр этой страницы, я всё понял')).toBe(false)
    expect(isLikelyHallucination('Thank you for sending the file, I got it')).toBe(false)
  })

  it('слово «корректор» в живой речи не считает подписью', () => {
    // В списке оно есть как подпись, но подстрокой ловить нельзя.
    expect(isLikelyHallucination('нам нужен корректор в команду')).toBe(false)
    expect(isLikelyHallucination('Корректор А.Егорова')).toBe(true)
  })

  it('не трогает обычные реплики', () => {
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
 * Подпись субтитров липнет к краю реплики. Раньше она утаскивала за собой всю
 * живую речь: на настоящей записи «Субтитры делал DimaTorzok» унесла тридцать
 * семь секунд разговора.
 */
describe('вырезание подписи из реплики', () => {
  it('убирает подпись, оставляя речь', () => {
    expect(
      stripHallucination('Субтитры делал DimaTorzok Если его весь можно разместить на поверхность.')
    ).toBe('Если его весь можно разместить на поверхность.')
  })

  it('подпись без речи убирает целиком', () => {
    expect(stripHallucination('Субтитры сделал DimaTorzok')).toBeNull()
    expect(stripHallucination('Subtitles by the Amara.org community')).toBeNull()
  })

  it('живую речь не трогает', () => {
    const text = 'надо обсудить биллинг и сроки по релизу'
    expect(stripHallucination(text)).toBe(text)
  })

  it('подпись в конце тоже убирается', () => {
    expect(stripHallucination('Обсудили сроки по релизу. Субтитры сделал DimaTorzok')).toBe(
      'Обсудили сроки по релизу.'
    )
  })

  it('пустая строка ничего не даёт', () => {
    expect(stripHallucination('   ')).toBeNull()
  })
})

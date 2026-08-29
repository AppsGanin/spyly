import { describe, expect, it } from 'vitest'
import { closedSentenceEnd, releaseSentence } from '../src/live.js'

describe('разбиение живого текста на фразы', () => {
  it('отпускает предложение, за которым уже прозвучало слово', () => {
    const text = 'Супер, в описании оставим. Бывает'
    expect(closedSentenceEnd(text)).toBe('Супер, в описании оставим.'.length)
  })

  it('ждёт следующего слова: точка могла быть сокращением', () => {
    expect(closedSentenceEnd('Возьмём договоры, счета и т.д.')).toBeNull()
  })

  it('берёт первое из нескольких законченных: одна строка — одно предложение', () => {
    const text = 'Первое слово. Второе слово. Третье'
    expect(closedSentenceEnd(text)).toBe('Первое слово.'.length)
  })

  it('понимает вопрос и восклицание', () => {
    expect(closedSentenceEnd('Ты придёшь? Да')).toBe('Ты придёшь?'.length)
    expect(closedSentenceEnd('Вот это да! Ну')).toBe('Вот это да!'.length)
  })

  it('не режет по одному слову', () => {
    // "Yes." on a line of its own looks ragged, so it is shown with what follows.
    expect(closedSentenceEnd('Да. Конечно')).toBeNull()
  })

  it('в незаконченной речи границы нет', () => {
    expect(closedSentenceEnd('и вот тогда мы решили')).toBeNull()
    expect(closedSentenceEnd('')).toBeNull()
  })

  it('многоточие тоже заканчивает фразу', () => {
    expect(closedSentenceEnd('Ну не знаю… Ладно')).toBe('Ну не знаю…'.length)
  })
})

describe('отступ уже показанного текста', () => {
  it('первая фраза отделяется от начала', () => {
    const result = releaseSentence('Супер, в описании оставим. Бывает', 0)
    expect(result).toEqual({ sentence: 'Супер, в описании оставим.', released: 26 })
  })

  /**
   * There was a bug here: the offset was added to the difference in lengths,
   * which already included it. The start of the second phrase was eaten:
   * «Бывает, конечно. С выпу…» turned into «сками обычно так».
   */
  it('вторая фраза не съедает начало третьей', () => {
    const whole = 'Первое предложение. Второе предложение. Третье'
    const first = releaseSentence(whole, 0)!
    expect(first.sentence).toBe('Первое предложение.')

    const second = releaseSentence(whole, first.released)!
    expect(second.sentence).toBe('Второе предложение.')
    expect(whole.slice(second.released).trim()).toBe('Третье')
  })

  it('отпускать нечего, пока предложение не закончено', () => {
    expect(releaseSentence('и вот тогда мы', 0)).toBeNull()
    // There is a full stop, but no next word yet, so the sentence may not have ended.
    expect(releaseSentence('Первое предложение.', 0)).toBeNull()
  })

  it('после отданного остатка ничего не отдаёт', () => {
    const whole = 'Одно предложение. Второе'
    const first = releaseSentence(whole, 0)!
    expect(releaseSentence(whole, first.released)).toBeNull()
  })
})

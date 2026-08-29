import { describe, expect, it } from 'vitest'
import { closedSentenceEnd, releaseSentence } from '../src/live.js'

describe('breaking live text into phrases', () => {
  it('releases a sentence once a word has been spoken after it', () => {
    const text = 'Супер, в описании оставим. Бывает'
    expect(closedSentenceEnd(text)).toBe('Супер, в описании оставим.'.length)
  })

  it('waits for the next word: the full stop may have been an abbreviation', () => {
    expect(closedSentenceEnd('Возьмём договоры, счета и т.д.')).toBeNull()
  })

  it('takes the first of several finished ones: one line, one sentence', () => {
    const text = 'Первое слово. Второе слово. Третье'
    expect(closedSentenceEnd(text)).toBe('Первое слово.'.length)
  })

  it('understands a question mark and an exclamation mark', () => {
    expect(closedSentenceEnd('Ты придёшь? Да')).toBe('Ты придёшь?'.length)
    expect(closedSentenceEnd('Вот это да! Ну')).toBe('Вот это да!'.length)
  })

  it('does not cut at a single word', () => {
    // "Yes." on a line of its own looks ragged, so it is shown with what follows.
    expect(closedSentenceEnd('Да. Конечно')).toBeNull()
  })

  it('in unfinished speech there is no boundary', () => {
    expect(closedSentenceEnd('и вот тогда мы решили')).toBeNull()
    expect(closedSentenceEnd('')).toBeNull()
  })

  it('an ellipsis also ends a phrase', () => {
    expect(closedSentenceEnd('Ну не знаю… Ладно')).toBe('Ну не знаю…'.length)
  })
})

describe('the offset of the text already shown', () => {
  it('the first phrase is separated from the start', () => {
    const result = releaseSentence('Супер, в описании оставим. Бывает', 0)
    expect(result).toEqual({ sentence: 'Супер, в описании оставим.', released: 26 })
  })

  /**
   * There was a bug here: the offset was added to the difference in lengths,
   * which already included it. The start of the second phrase was eaten:
   * «Бывает, конечно. С выпу…» turned into «сками обычно так».
   */
  it('the second phrase does not eat the start of the third', () => {
    const whole = 'Первое предложение. Второе предложение. Третье'
    const first = releaseSentence(whole, 0)!
    expect(first.sentence).toBe('Первое предложение.')

    const second = releaseSentence(whole, first.released)!
    expect(second.sentence).toBe('Второе предложение.')
    expect(whole.slice(second.released).trim()).toBe('Третье')
  })

  it('there is nothing to release until a sentence is finished', () => {
    expect(releaseSentence('и вот тогда мы', 0)).toBeNull()
    // There is a full stop, but no next word yet, so the sentence may not have ended.
    expect(releaseSentence('Первое предложение.', 0)).toBeNull()
  })

  it('after the remainder has gone out it gives nothing more', () => {
    const whole = 'Одно предложение. Второе'
    const first = releaseSentence(whole, 0)!
    expect(releaseSentence(whole, first.released)).toBeNull()
  })
})

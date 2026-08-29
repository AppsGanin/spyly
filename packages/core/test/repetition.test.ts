import { describe, expect, it } from 'vitest'
import { isLikelyHallucination } from '../src/hallucination.js'

// Whisper falls into repeating one phrase where the person said nothing of the
// kind. A check for a single repeated word did not catch that.
describe('looping output', () => {
  it('catches a phrase repeated many times', () => {
    expect(isLikelyHallucination('Я не знаю, что это значит. '.repeat(14))).toBe(true)
  })

  it('catches a repeat with a meaningful tail', () => {
    const text =
      'Там назначение новой роли, оно только новую роль. '.repeat(6) +
      'назначает, то есть я имею в виду'
    expect(isLikelyHallucination(text)).toBe(true)
  })

  it('catches a phrase and its cut-off repeat', () => {
    expect(isLikelyHallucination('Я не знаю, что это значит. Я не знаю, что это')).toBe(true)
  })

  it('catches getting stuck on one word', () => {
    expect(isLikelyHallucination('Да да да да да да')).toBe(true)
  })

  it('leaves ordinary speech alone', () => {
    const normal = [
      'Привет, нам нужно переделать расчёт подписок в биллинге до конца недели',
      'Согласен. Я возьму на себя миграцию базы данных и напишу тесты.',
      'Это надо будет посмотреть на Бекина, но по идее такого не должно быть.',
      'Ну вот тоже так думаю. Если что, если сначала как назначаешь?',
      'Да, да, конечно — сделаем на этой неделе'
    ]
    for (const text of normal) {
      expect(isLikelyHallucination(text), text).toBe(false)
    }
  })

  it('short repeats in speech do not count as being stuck', () => {
    // People do repeat themselves: "all right, all right" is a normal utterance.
    expect(isLikelyHallucination('Хорошо, хорошо')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { isLikelyHallucination } from '../src/hallucination.js'

// Whisper falls into repeating one phrase where the person said nothing of the
// kind. A check for a single repeated word did not catch that.
describe('зацикленный вывод', () => {
  it('ловит фразу, повторённую много раз', () => {
    expect(isLikelyHallucination('Я не знаю, что это значит. '.repeat(14))).toBe(true)
  })

  it('ловит повтор с осмысленным хвостом', () => {
    const text =
      'Там назначение новой роли, оно только новую роль. '.repeat(6) +
      'назначает, то есть я имею в виду'
    expect(isLikelyHallucination(text)).toBe(true)
  })

  it('ловит фразу и её оборванный повтор', () => {
    expect(isLikelyHallucination('Я не знаю, что это значит. Я не знаю, что это')).toBe(true)
  })

  it('ловит залипание на одном слове', () => {
    expect(isLikelyHallucination('Да да да да да да')).toBe(true)
  })

  it('не трогает обычную речь', () => {
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

  it('короткие повторы речи не считает залипанием', () => {
    // People do repeat themselves: "all right, all right" is a normal utterance.
    expect(isLikelyHallucination('Хорошо, хорошо')).toBe(false)
  })
})

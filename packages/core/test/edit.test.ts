import { describe, expect, it } from 'vitest'
import {
  doubtThreshold,
  doubtfulWords,
  mergeUtterances,
  splitUtterance,
  utteranceConfidence
} from '../src/edit.js'
import type { Utterance } from '../src/types.js'

function make(overrides: Partial<Utterance> = {}): Utterance {
  return {
    id: 'u1',
    speakerId: 'remote:0',
    track: 'system',
    start: 10,
    end: 20,
    text: 'привет как дела нормально',
    words: [],
    provisional: false,
    ...overrides
  }
}

describe('splitUtterance', () => {
  it('делит по границе слова, когда таймкоды есть', () => {
    const utterance = make({
      words: [
        { text: 'привет', start: 10, end: 11 },
        { text: 'как', start: 12, end: 12.5 },
        { text: 'дела', start: 13, end: 14 },
        { text: 'нормально', start: 17, end: 19 }
      ]
    })
    const parts = splitUtterance(utterance, 'привет как дела '.length)
    expect(parts).not.toBeNull()
    const [head, tail] = parts!
    expect(head.text).toBe('привет как дела')
    expect(tail.text).toBe('нормально')
    expect(head.end).toBe(17)
    expect(tail.start).toBe(17)
    expect(head.words).toHaveLength(3)
    expect(tail.words).toHaveLength(1)
  })

  it('без таймкодов делит пропорционально длине', () => {
    const [head, tail] = splitUtterance(make({ text: 'абвг', words: [] }), 2)!
    expect(head.text).toBe('аб')
    expect(tail.text).toBe('вг')
    expect(head.end).toBe(15)
  })

  it('не делит, если одна половина пустая', () => {
    expect(splitUtterance(make(), 0)).toBeNull()
    expect(splitUtterance(make(), 999)).toBeNull()
  })

  // Splitting an utterance twice easily gives two identical identifiers, and
  // after that an edit would land on the wrong utterance.
  it('второе деление не повторяет уже занятый идентификатор', () => {
    const base = make({ text: 'один два три четыре' })
    const [head, tail] = splitUtterance(base, 9, new Set([base.id]))!
    const taken = new Set([head.id, tail.id])
    const [again, extra] = splitUtterance(head, 4, taken)!
    const ids = [again.id, extra.id, tail.id]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('половинки не выходят за границы исходной реплики', () => {
    const [head, tail] = splitUtterance(make({ text: 'раз два' }), 3)!
    expect(head.start).toBe(10)
    expect(tail.end).toBe(20)
    expect(head.end).toBeGreaterThanOrEqual(10)
    expect(head.end).toBeLessThanOrEqual(20)
  })
})

describe('mergeUtterances', () => {
  it('склеивает текст и растягивает границы', () => {
    const merged = mergeUtterances(
      make({ text: 'первая', start: 10, end: 12 }),
      make({ id: 'u2', speakerId: 'local:0', text: 'вторая', start: 12, end: 15 })
    )
    expect(merged.text).toBe('первая вторая')
    expect(merged.start).toBe(10)
    expect(merged.end).toBe(15)
    // The speaker stays from the first: joining happens when the second was attributed to the wrong person.
    expect(merged.speakerId).toBe('remote:0')
  })

  it('слова остаются в порядке времени', () => {
    const merged = mergeUtterances(
      make({ words: [{ text: 'б', start: 12, end: 13 }] }),
      make({ id: 'u2', words: [{ text: 'а', start: 10, end: 11 }] })
    )
    expect(merged.words.map((w) => w.text)).toEqual(['а', 'б'])
  })
})

describe('уверенность', () => {
  it('находит слова, в которых модель сомневалась', () => {
    const utterance = make({
      words: [
        { text: 'точно', start: 10, end: 11, confidence: 0.95 },
        { text: 'вроде', start: 11, end: 12, confidence: 0.31 }
      ]
    })
    expect([...doubtfulWords(utterance)]).toEqual([1])
  })

  it('без данных об уверенности не выдумывает её', () => {
    expect(utteranceConfidence(make())).toBeNull()
  })

  it('на короткой записи берёт разумный порог по умолчанию', () => {
    expect(doubtThreshold({ utterances: [make()] })).toBe(0.6)
  })

  it('на шумной записи подчёркивает только худшее, а не всё подряд', () => {
    // Here the model is unsure everywhere: a fixed threshold of 0.6 would underline
    // almost the whole text and become useless.
    const words = Array.from({ length: 40 }, (_, i) => ({
      text: `с${i}`,
      start: i,
      end: i + 0.5,
      confidence: 0.5 + (i % 10) * 0.02
    }))
    const threshold = doubtThreshold({ utterances: [make({ words })] })
    const flagged = words.filter((w) => w.confidence < threshold).length
    expect(flagged).toBeLessThan(words.length / 4)
  })

  it('усредняет по словам', () => {
    const utterance = make({
      words: [
        { text: 'а', start: 10, end: 11, confidence: 0.4 },
        { text: 'б', start: 11, end: 12, confidence: 0.8 }
      ]
    })
    expect(utteranceConfidence(utterance)).toBeCloseTo(0.6)
  })
})

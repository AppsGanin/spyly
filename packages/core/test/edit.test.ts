import { describe, expect, it } from 'vitest'
import {doubtThreshold, doubtfulWords, utteranceConfidence } from '../src/edit.js'
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

describe('confidence', () => {
  it('finds the words the model was unsure about', () => {
    const utterance = make({
      words: [
        { text: 'точно', start: 10, end: 11, confidence: 0.95 },
        { text: 'вроде', start: 11, end: 12, confidence: 0.31 }
      ]
    })
    expect([...doubtfulWords(utterance)]).toEqual([1])
  })

  it('does not invent confidence when there is none', () => {
    expect(utteranceConfidence(make())).toBeNull()
  })

  it('on a short recording it takes a sensible default threshold', () => {
    expect(doubtThreshold({ utterances: [make()] })).toBe(0.6)
  })

  it('on a noisy recording it underlines only the worst, not everything', () => {
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

  it('averages over the words', () => {
    const utterance = make({
      words: [
        { text: 'а', start: 10, end: 11, confidence: 0.4 },
        { text: 'б', start: 11, end: 12, confidence: 0.8 }
      ]
    })
    expect(utteranceConfidence(utterance)).toBeCloseTo(0.6)
  })
})

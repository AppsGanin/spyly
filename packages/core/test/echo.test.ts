import { describe, expect, it } from 'vitest'
import { keepOwnVoice, levelAt, micIsOnlyEcho, micIsOwnVoice, trimEchoedStart, type LevelWindow } from '../src/echo.js'
import type { Utterance, Word } from '../src/types.js'

/**
 * The numbers are taken from a real recording where the person was silent and
 * the microphone recorded nothing but the speakers: the ratio of levels held
 * around 0.20 and barely wavered.
 */
const windows = (values: number[]): LevelWindow[] =>
  values.map((rms, i) => ({ start: i * 0.25, end: (i + 1) * 0.25, rms }))

describe('своя речь или эхо динамиков', () => {
  it('эхо динамиков своей речью не считает', () => {
    expect(micIsOwnVoice(0.016, 0.081)).toBe(false)
  })

  it('живую речь пропускает', () => {
    // The person speaks over a quiet other side.
    expect(micIsOwnVoice(0.12, 0.02)).toBe(true)
  })

  it('в тишине системной дорожки считает речь своей', () => {
    // There is nothing to compare against, so someone was speaking into the microphone.
    expect(micIsOwnVoice(0.03, 0.001)).toBe(true)
  })

  it('видит дорожку, в которой одно эхо', () => {
    const mic = windows(Array.from({ length: 40 }, () => 0.016))
    const system = windows(Array.from({ length: 40 }, () => 0.081))
    expect(micIsOnlyEcho(mic, system)).toBe(true)
  })

  it('дорожку с настоящей речью эхом не признаёт', () => {
    const mic = windows([...Array.from({ length: 30 }, () => 0.016), ...Array.from({ length: 10 }, () => 0.15)])
    const system = windows(Array.from({ length: 40 }, () => 0.081))
    expect(micIsOnlyEcho(mic, system)).toBe(false)
  })

  it('молчащую дорожку считает пустой', () => {
    expect(micIsOnlyEcho(windows([0.001, 0.002]), windows([0.08, 0.08]))).toBe(true)
  })

  it('громкость на отрезке усредняет только по нему', () => {
    const levels = windows([0.1, 0.2, 0.9, 0.9])
    expect(levelAt(levels, 0, 0.5)).toBeCloseTo(0.15)
  })
})

/**
 * The other side's last word sticks to the start of your own utterance: the
 * two tracks are cut into pieces differently. On a real recording "...but then
 * I am certainly ready" turned into "ready, nice, nice..." under your name.
 */
describe('чужой хвост в начале реплики', () => {
  const word = (text: string, start: number): Word => ({ text, start, end: start + 0.4 })

  const mine: Utterance = {
    id: 'u1',
    speakerId: 'mic:0',
    track: 'mic',
    start: 106.9,
    end: 110,
    text: 'готов прикольно прикольно да',
    words: [word('готов', 106.9), word('прикольно', 107.4), word('прикольно', 108), word('да', 108.6)],
    provisional: false
  }
  const remote = { text: 'Поэтому имеет смысл читать комментарии, но тогда я, конечно, готов.', end: 106.5 }

  // The word that stuck is quiet, so the microphone was hearing the speakers; your own speech is loud.
  const levels = {
    mic: (from: number) => (from < 107.3 ? 0.016 : 0.12),
    system: () => 0.08
  }

  it('срезает приклеившееся слово', () => {
    const result = trimEchoedStart(mine, remote, levels)
    expect(result.text).toBe('прикольно прикольно да')
    expect(result.start).toBeCloseTo(107.4)
  })

  it('своё слово не трогает, даже если оно совпало с чужим', () => {
    // A person really can repeat someone else's word, but loudly, in their own voice.
    const loud = { mic: () => 0.12, system: () => 0.08 }
    expect(trimEchoedStart(mine, remote, loud).text).toBe(mine.text)
  })

  it('без соседней чужой реплики ничего не меняет', () => {
    expect(trimEchoedStart(mine, null, levels).text).toBe(mine.text)
  })

  it('давнюю чужую реплику к стыку не приплетает', () => {
    const old = { ...remote, end: 90 }
    expect(trimEchoedStart(mine, old, levels).text).toBe(mine.text)
  })

  it('всю реплику не съедает', () => {
    const echoOnly: Utterance = { ...mine, text: 'готов', words: [word('готов', 106.9)] }
    expect(trimEchoedStart(echoOnly, remote, levels).text).toBe('готов')
  })
})

/**
 * Recognition places word times approximately, and a word that stuck often ends
 * up where both tracks are silent. On a real recording the word "ready" stood
 * at 106.9 s, where the microphone gave 0.001 and the system gave zero.
 */
describe('слово на тишине', () => {
  const word = (text: string, start: number): Word => ({ text, start, end: start + 0.4 })
  const mine: Utterance = {
    id: 'u1',
    speakerId: 'mic:0',
    track: 'mic',
    start: 106.9,
    end: 112,
    text: 'готов прикольно прикольно',
    words: [word('готов', 106.9), word('прикольно', 107.8), word('прикольно', 109.7)],
    provisional: false
  }
  const remote = { text: 'но тогда я, конечно, готов.', end: 106.0 }

  it('срезает слово, под которым тишина на обеих дорожках', () => {
    const levels = {
      mic: (from: number) => (from < 107.5 ? 0.001 : 0.019),
      system: () => 0
    }
    expect(trimEchoedStart(mine, remote, levels).text).toBe('прикольно прикольно')
  })

  it('громкое слово оставляет, даже если система молчит', () => {
    // The person really did say "ready" into the silence, so it is their word.
    const levels = { mic: () => 0.05, system: () => 0 }
    expect(trimEchoedStart(mine, remote, levels).text).toBe(mine.text)
  })
})

/**
 * A microphone utterance is often glued from two halves: first the other
 * side's echo, then speech of your own. On a real recording such an utterance
 * gave an average ratio of 0.52 and was discarded whole, along with the words
 * "I don't know what it means", spoken in complete silence from the speakers.
 */
describe('своя речь внутри реплики с эхом', () => {
  const word = (text: string, start: number): Word => ({ text, start, end: start + 0.4 })
  const utterance = (words: Word[]): Utterance => ({
    id: 'u1',
    speakerId: 'mic:0',
    track: 'mic',
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: words.map((w) => w.text).join(' '),
    words,
    provisional: false
  })

  // Up to 110 s the other side speaks; after that the speakers are silent and the person talks.
  const levels = {
    mic: () => 0.02,
    system: (from: number) => (from < 109.5 ? 0.1 : 0)
  }

  it('оставляет ту половину, где динамики молчат', () => {
    const result = keepOwnVoice(
      utterance([
        word('принцип', 108.3),
        word('что', 108.8),
        word('он', 109.2),
        word('означает', 110.5),
        word('и', 111.0),
        word('я', 111.5),
        word('не', 112.0),
        word('знаю', 112.5)
      ]),
      levels
    )
    expect(result?.text).toBe('означает и я не знаю')
    expect(result?.start).toBeCloseTo(110.5)
  })

  it('сплошное эхо не оставляет ничего', () => {
    const result = keepOwnVoice(
      utterance([word('чужие', 100), word('слова', 100.5), word('целиком', 101)]),
      { mic: () => 0.02, system: () => 0.1 }
    )
    expect(result).toBeNull()
  })

  it('свою речь целиком не трогает', () => {
    const own = utterance([word('привет', 0), word('всем', 0.5), word('как', 1), word('дела', 1.5)])
    expect(keepOwnVoice(own, { mic: () => 0.05, system: () => 0 })).toBe(own)
  })

  it('огрызок в полсекунды посреди чужой речи не показывает', () => {
    const result = keepOwnVoice(
      utterance([
        word('чужое', 98.0),
        word('да', 98.1),
        word('все', 98.3),
        word('нас', 98.5),
        word('снова', 99.0)
      ]),
      { mic: () => 0.02, system: (from: number) => (from > 98.05 && from < 98.9 ? 0 : 0.1) }
    )
    expect(result).toBeNull()
  })
})

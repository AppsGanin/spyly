import { describe, expect, it } from 'vitest'
import {
  ECHO_CORRELATION_THRESHOLD,
  ECHO_LOUDNESS_LIMIT,
  echoMatch,
  keepOwnVoice,
  levelAt,
  micIsOnlyEcho,
  micIsOwnVoice,
  trimEchoedStart,
  type LevelWindow
} from '../src/echo.js'
import type { Utterance, Word } from '../src/types.js'

/**
 * The numbers are taken from a real recording where the person was silent and
 * the microphone recorded nothing but the speakers: the ratio of levels held
 * around 0.20 and barely wavered.
 */
const windows = (values: number[]): LevelWindow[] =>
  values.map((rms, i) => ({ start: i * 0.25, end: (i + 1) * 0.25, rms }))

describe('your own speech or speaker echo', () => {
  it('does not count speaker echo as your own speech', () => {
    expect(micIsOwnVoice(0.016, 0.081)).toBe(false)
  })

  it('lets live speech through', () => {
    // The person speaks over a quiet other side.
    expect(micIsOwnVoice(0.12, 0.02)).toBe(true)
  })

  it('with the system track silent it counts the speech as yours', () => {
    // There is nothing to compare against, so someone was speaking into the microphone.
    expect(micIsOwnVoice(0.03, 0.001)).toBe(true)
  })

  it('sees a track that is nothing but echo', () => {
    const mic = windows(Array.from({ length: 40 }, () => 0.016))
    const system = windows(Array.from({ length: 40 }, () => 0.081))
    expect(micIsOnlyEcho(mic, system)).toBe(true)
  })

  it('does not take a track with real speech for echo', () => {
    const mic = windows([...Array.from({ length: 30 }, () => 0.016), ...Array.from({ length: 10 }, () => 0.15)])
    const system = windows(Array.from({ length: 40 }, () => 0.081))
    expect(micIsOnlyEcho(mic, system)).toBe(false)
  })

  it('counts a silent track as empty', () => {
    expect(micIsOnlyEcho(windows([0.001, 0.002]), windows([0.08, 0.08]))).toBe(true)
  })

  it('averages the level over the stretch alone', () => {
    const levels = windows([0.1, 0.2, 0.9, 0.9])
    expect(levelAt(levels, 0, 0.5)).toBeCloseTo(0.15)
  })
})

/**
 * The other side's last word sticks to the start of your own utterance: the
 * two tracks are cut into pieces differently. On a real recording "...but then
 * I am certainly ready" turned into "ready, nice, nice..." under your name.
 */
describe('somebody else\'s tail at the start of an utterance', () => {
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

  it('trims the word that stuck', () => {
    const result = trimEchoedStart(mine, remote, levels)
    expect(result.text).toBe('прикольно прикольно да')
    expect(result.start).toBeCloseTo(107.4)
  })

  it('leaves your own word alone, even when it matches theirs', () => {
    // A person really can repeat someone else's word, but loudly, in their own voice.
    const loud = { mic: () => 0.12, system: () => 0.08 }
    expect(trimEchoedStart(mine, remote, loud).text).toBe(mine.text)
  })

  it('with no neighbouring utterance it changes nothing', () => {
    expect(trimEchoedStart(mine, null, levels).text).toBe(mine.text)
  })

  it('does not drag a distant utterance into the seam', () => {
    const old = { ...remote, end: 90 }
    expect(trimEchoedStart(mine, old, levels).text).toBe(mine.text)
  })

  it('does not eat the whole utterance', () => {
    const echoOnly: Utterance = { ...mine, text: 'готов', words: [word('готов', 106.9)] }
    expect(trimEchoedStart(echoOnly, remote, levels).text).toBe('готов')
  })
})

/**
 * Recognition places word times approximately, and a word that stuck often ends
 * up where both tracks are silent. On a real recording the word "ready" stood
 * at 106.9 s, where the microphone gave 0.001 and the system gave zero.
 */
describe('a word over silence', () => {
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

  it('trims a word with silence under it on both tracks', () => {
    const levels = {
      mic: (from: number) => (from < 107.5 ? 0.001 : 0.019),
      system: () => 0
    }
    expect(trimEchoedStart(mine, remote, levels).text).toBe('прикольно прикольно')
  })

  it('keeps a loud word even when the system is silent', () => {
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
describe('your own speech inside an utterance with echo', () => {
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

  it('keeps the half where the speakers are silent', () => {
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

  it('solid echo leaves nothing', () => {
    const result = keepOwnVoice(
      utterance([word('чужие', 100), word('слова', 100.5), word('целиком', 101)]),
      { mic: () => 0.02, system: () => 0.1 }
    )
    expect(result).toBeNull()
  })

  it('leaves your own speech entirely alone', () => {
    const own = utterance([word('привет', 0), word('всем', 0.5), word('как', 1), word('дела', 1.5)])
    expect(keepOwnVoice(own, { mic: () => 0.05, system: () => 0 })).toBe(own)
  })

  it('does not show a half-second scrap in the middle of their speech', () => {
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

describe('the speakers heard again in the microphone', () => {
  const frameSec = 0.02

  /**
   * A phrase as an outline: loud where the words are, quiet in the pauses.
   *
   * Deliberately irregular. A first attempt built it from two sines, and two
   * different "phrases" then matched at 0.91 — periodic outlines line up at some
   * shift whatever is in them, and speech is not periodic.
   */
  function phrase(frames: number, seed: number): number[] {
    let state = seed * 2654435761
    const next = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state / 0x7fffffff
    }
    const out: number[] = []
    while (out.length < frames) {
      // A word, then a pause: the lengths of both are what makes the outline.
      const word = 3 + Math.floor(next() * 12)
      const loud = 0.15 + next() * 0.5
      for (let i = 0; i < word && out.length < frames; i++) out.push(loud * (0.6 + next() * 0.4))
      const pause = 1 + Math.floor(next() * 8)
      for (let i = 0; i < pause && out.length < frames; i++) out.push(0.01 * next())
    }
    return out
  }
  function track(parts: { at: number; data: number[] }[], frames: number): Float32Array {
    const out = new Float32Array(frames)
    for (const p of parts) p.data.forEach((v, i) => { out[p.at + i] = v })
    return out
  }

  it('the same sound, quieter and later, is echo', () => {
    const said = phrase(150, 1)
    const system = track([{ at: 100, data: said }], 500)
    // The microphone heard the same thing 0.5 s later and four times quieter.
    const mic = track([{ at: 125, data: said.map((v) => v * 0.25) }], 500)
    const m = echoMatch(mic, system, { frameSec, from: 125 * frameSec, to: 275 * frameSec })
    expect(m.correlation).toBeGreaterThan(ECHO_CORRELATION_THRESHOLD)
    expect(m.ratio).toBeLessThan(ECHO_LOUDNESS_LIMIT)
    expect(m.shiftSec).toBeCloseTo(-0.5, 1)
  })

  it('a different sound at the same moment is not echo', () => {
    const system = track([{ at: 100, data: phrase(150, 1) }], 500)
    const mic = track([{ at: 100, data: phrase(150, 11) }], 500)
    const m = echoMatch(mic, system, { frameSec, from: 2, to: 5 })
    expect(m.correlation).toBeLessThan(ECHO_CORRELATION_THRESHOLD)
  })

  /** Talking over the other side gives the same outline — but you are the loud one. */
  it('speaking over the other side is told apart by loudness', () => {
    const said = phrase(150, 1)
    const system = track([{ at: 100, data: said }], 500)
    const mic = track([{ at: 100, data: said.map((v) => v * 3) }], 500)
    const m = echoMatch(mic, system, { frameSec, from: 2, to: 5 })
    expect(m.ratio).toBeGreaterThan(ECHO_LOUDNESS_LIMIT)
  })

  it('against silence from the speakers nothing matches', () => {
    const mic = track([{ at: 100, data: phrase(150, 1) }], 500)
    const m = echoMatch(mic, new Float32Array(500), { frameSec, from: 2, to: 5 })
    expect(m.correlation).toBe(0)
  })

  /** Half a second agrees with anything by chance, so it is not judged at all. */
  it('too short a stretch is not judged', () => {
    const said = phrase(150, 1)
    const system = track([{ at: 100, data: said }], 500)
    const mic = track([{ at: 100, data: said }], 500)
    expect(echoMatch(mic, system, { frameSec, from: 2, to: 2.2 }).correlation).toBe(0)
  })
})

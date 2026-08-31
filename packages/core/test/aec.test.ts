import { describe, expect, it } from 'vitest'
import { removeSpeakers } from '../src/aec.js'

/**
 * The microphone hears two things at once: the person, and the speakers playing
 * the other side. Only what the speakers explain may be taken away.
 */
describe('taking the speakers out of the microphone', () => {
  const rate = 16000

  /** A tone with a shaped loudness, standing in for a phrase. */
  function voice(seconds: number, hz: number, at = 0): Float32Array {
    const out = new Float32Array(Math.round(rate * seconds))
    for (let i = 0; i < out.length; i++) {
      const t = i / rate
      const shape = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.7 * (t + at))
      out[i] = 0.3 * shape * Math.sin(2 * Math.PI * hz * t)
    }
    return out
  }
  function energy(a: Float32Array): number {
    let s = 0
    for (const v of a) s += v * v
    return Math.sqrt(s / a.length)
  }

  it('the speakers alone are all but gone from the microphone', () => {
    const system = voice(4, 300)
    // The microphone heard only them, four times quieter.
    const mic = system.map((v) => v * 0.25) as Float32Array
    const clean = removeSpeakers(mic, system, rate)
    expect(energy(clean)).toBeLessThan(energy(mic) * 0.4)
  })

  it('speech of your own, with the speakers silent, passes through', () => {
    const mine = voice(4, 700)
    const clean = removeSpeakers(mine, new Float32Array(mine.length), rate)
    // Only the loss to the windowing at the very edges.
    expect(energy(clean)).toBeGreaterThan(energy(mine) * 0.85)
  })

  it('with both at once, yours is kept and theirs is taken down', () => {
    const system = voice(4, 300)
    const mine = voice(4, 900, 0.3)
    const mic = new Float32Array(mine.length)
    for (let i = 0; i < mic.length; i++) mic[i] = mine[i]! + system[i]! * 0.25
    const clean = removeSpeakers(mic, system, rate)

    // What is left has to be closer to one's own voice than what went in was.
    const distance = (a: Float32Array): number => {
      let s = 0
      for (let i = 0; i < a.length; i++) s += (a[i]! - mine[i]!) ** 2
      return Math.sqrt(s / a.length)
    }
    expect(distance(clean)).toBeLessThan(distance(mic))
  })

  /** The tracks do not start together; the shift is given from outside. */
  it('a shift between the tracks is allowed for', () => {
    const system = voice(4, 300)
    const shift = Math.round(rate * 0.2)
    const mic = new Float32Array(system.length)
    for (let i = shift; i < mic.length; i++) mic[i] = system[i - shift]! * 0.25
    const clean = removeSpeakers(mic, system, rate, 0.2)
    expect(energy(clean)).toBeLessThan(energy(mic) * 0.5)
  })
})

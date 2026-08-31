import type { Utterance } from './types.js'

/**
 * Telling "me" from "the other side" by the levels of the tracks.
 *
 * All voice separation rests on one assumption: the microphone is whoever sits
 * at the computer, the system audio is the remote participants. The assumption
 * collapses the moment a person takes their headphones off: the speakers play
 * the other side, the microphone records them, and their utterances appear in
 * the transcript twice, the second time under your name.
 *
 * Comparing the texts is a poor cure: recognition of the two tracks diverges so
 * far that on a real recording only three echoes out of five were recognised by
 * text. The physics, though, is reliable. The path from speakers to microphone
 * weakens the sound several times over, and on a real recording the ratio of
 * levels held around 0.20 with a spread in the hundredths. When a person speaks
 * themselves, their microphone is louder than what plays through the speakers,
 * and the difference is not in percent but in multiples.
 */

/**
 * How many times louder than the system audio the microphone has to be for an
 * utterance to count as your own.
 *
 * The threshold has a wide margin: echo gave 0.2, live speech gives markedly
 * more than one. The gap between them is wide, and landing in it by accident is
 * hard.
 */
export const MIC_OVER_SYSTEM_RATIO = 0.6

/** Below this level there is no speech under a word, only silence. */
export const SPEECH_RMS_THRESHOLD = 0.006

export interface LevelWindow {
  start: number
  end: number
  rms: number
}

/** The average level of a track over a stretch. */
export function levelAt(windows: readonly LevelWindow[], start: number, end: number): number {
  let sum = 0
  let count = 0
  for (const w of windows) {
    if (w.end <= start || w.start >= end) continue
    sum += w.rms
    count++
  }
  return count > 0 ? sum / count : 0
}

/**
 * Whether the microphone heard a person rather than the speakers.
 *
 * If the system track is silent at that moment there is nothing to compare
 * against, which means someone was speaking into the microphone.
 */
export function micIsOwnVoice(micRms: number, systemRms: number): boolean {
  if (systemRms < 0.01) return true
  return micRms >= systemRms * MIC_OVER_SYSTEM_RATIO
}

/**
 * Whether the microphone hears the speakers and nothing else.
 *
 * Computed over the whole recording: if at no moment of its own speech the
 * microphone was louder than the system audio, the person was silent
 * throughout and the track holds pure echo. Its contribution to the transcript
 * is then nothing but harm.
 */
export function micIsOnlyEcho(
  micWindows: readonly LevelWindow[],
  systemWindows: readonly LevelWindow[]
): boolean {
  const speaking = micWindows.filter((w) => w.rms > 0.006)
  if (speaking.length === 0) return true

  const own = speaking.filter((w) => micIsOwnVoice(w.rms, levelAt(systemWindows, w.start, w.end)))
  // Isolated spikes happen from a knock on the desk: a proportion is needed, not a single fact.
  return own.length / speaking.length < 0.05
}

/**
 * How closely the outlines must agree for one sound to be the other heard again.
 *
 * Measured on an hour-long call where the speakers were loud: echo gave 0.81 to
 * 0.99, and everything the person said themselves gave 0.12 to 0.44. The gap in
 * between is wide and empty, and the threshold stands in the middle of it.
 */
export const ECHO_CORRELATION_THRESHOLD = 0.75

/**
 * How much quieter than the speakers the microphone must be for it to be echo.
 *
 * The outline is not enough on its own: talking over the other side gives the
 * same agreement, because their voice is in the microphone too. But then the
 * person is the louder one. On that call echo held 0.23 to 0.66, and speech of
 * their own 0.83 and above.
 */
export const ECHO_LOUDNESS_LIMIT = 0.8

/**
 * The shape of a sound over time, in short frames.
 *
 * Loudness alone, at a fine enough step to keep the outline of speech: the
 * pauses between words, where a phrase rises and where it falls. Two recordings
 * of one sound have the same outline even when they differ in everything else.
 */
export function envelope(samples: Float32Array, sampleRate: number, frameSec = 0.02): Float32Array {
  const size = Math.max(1, Math.round(sampleRate * frameSec))
  const out = new Float32Array(Math.floor(samples.length / size))
  for (let f = 0; f < out.length; f++) {
    let energy = 0
    const at = f * size
    for (let i = at; i < at + size; i++) energy += samples[i]! * samples[i]!
    out[f] = Math.sqrt(energy / size)
  }
  return out
}

/** Pearson correlation of two equal stretches; 0 when either is flat. */
function pearson(a: Float32Array, aFrom: number, b: Float32Array, bFrom: number, length: number): number {
  let sa = 0
  let sb = 0
  for (let i = 0; i < length; i++) {
    sa += a[aFrom + i]!
    sb += b[bFrom + i]!
  }
  const ma = sa / length
  const mb = sb / length

  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < length; i++) {
    const da = a[aFrom + i]! - ma
    const db = b[bFrom + i]! - mb
    cov += da * db
    va += da * da
    vb += db * db
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0
}

/**
 * How much of a stretch of the microphone is the system audio heard again.
 *
 * This is the honest question, and the levels were only ever a proxy for it. If
 * the speakers played a phrase and the microphone picked it up, the two
 * recordings hold one sound, and their outlines coincide — at some shift, since
 * the tracks do not start together and the path through the air takes its time.
 * So the shift is searched for and the best agreement returned.
 *
 * `ratio` is how loud the microphone was against the speakers over the same
 * stretch. Echo comes back quieter; a person talking over the other side is
 * not, and the two are told apart by this even when the outlines agree.
 */
export function echoMatch(
  micEnvelope: Float32Array,
  systemEnvelope: Float32Array,
  options: { frameSec: number; from: number; to: number; maxShiftSec?: number }
): { correlation: number; shiftSec: number; ratio: number } {
  const { frameSec, from, to } = options
  const maxShift = Math.round((options.maxShiftSec ?? 3) / frameSec)

  const start = Math.max(0, Math.round(from / frameSec))
  const length = Math.round((to - from) / frameSec)
  const none = { correlation: 0, shiftSec: 0, ratio: 0 }
  // Too short a stretch agrees with anything by chance.
  if (length < Math.round(0.5 / frameSec) || start + length > micEnvelope.length) return none

  let best = 0
  let bestShift = 0
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    const at = start + shift
    if (at < 0 || at + length > systemEnvelope.length) continue
    const r = pearson(micEnvelope, start, systemEnvelope, at, length)
    if (r > best) {
      best = r
      bestShift = shift
    }
  }

  let micSum = 0
  let systemSum = 0
  for (let i = 0; i < length; i++) {
    micSum += micEnvelope[start + i]!
    const at = start + bestShift + i
    systemSum += at >= 0 && at < systemEnvelope.length ? systemEnvelope[at]! : 0
  }
  return {
    correlation: best,
    shiftSec: bestShift * frameSec,
    ratio: systemSum > 0 ? micSum / systemSum : 0
  }
}

/**
 * How the shift between the tracks changes over a recording.
 *
 * Measured in segments rather than once: on recordings made before the tracks
 * were kept in step it grows over the hour, and a single number for the whole
 * file fits the beginning or the end but not both. Segments where the speakers
 * were silent, and there is nothing to measure against, inherit the last shift
 * that was found.
 */
export function shiftProfile(
  micEnvelope: Float32Array,
  systemEnvelope: Float32Array,
  options: { frameSec: number; segmentSec?: number; maxShiftSec?: number } = { frameSec: 0.02 }
): { at: number; shiftSec: number }[] {
  const { frameSec } = options
  const segment = options.segmentSec ?? 60
  const total = micEnvelope.length * frameSec
  const out: { at: number; shiftSec: number }[] = []

  let last = 0
  for (let at = 0; at < total; at += segment) {
    const match = echoMatch(micEnvelope, systemEnvelope, {
      frameSec,
      from: at,
      to: Math.min(at + segment, total),
      maxShiftSec: options.maxShiftSec
    })
    // A weak agreement means there was no echo to measure — the speakers were
    // silent, or the person had headphones on. Keeping the previous shift is
    // safer than believing a number found in noise.
    if (match.correlation >= 0.5) last = -match.shiftSec
    out.push({ at, shiftSec: last })
  }
  return out
}

/** Look the shift up for a moment in time. */
export function shiftAt(profile: readonly { at: number; shiftSec: number }[], atSec: number): number {
  if (profile.length === 0) return 0
  let found = profile[0]!.shiftSec
  for (const point of profile) {
    if (point.at > atSec) break
    found = point.shiftSec
  }
  return found
}

/**
 * Trim someone else's tail from the start of your own utterance.
 *
 * The two tracks are cut into pieces differently, and the other side's last
 * word often lands at the start of your utterance: "...but then I am certainly
 * ready" followed by your own "ready, nice, nice". Throwing the utterance away
 * whole will not do, it is yours; exactly the words that stuck have to come off.
 *
 * A word is removed only when both signs agree: it is present at the end of the
 * neighbouring utterance from the other side, and the microphone was quieter
 * than the speakers at that moment. Text alone is not enough, as a person may
 * genuinely repeat someone else's word, and losing it would be a shame.
 */
export function trimEchoedStart(
  utterance: Utterance,
  previousRemote: { text: string; end: number } | null,
  levels: { mic: (from: number, to: number) => number; system: (from: number, to: number) => number },
  options: { maxWords?: number; gapSec?: number } = {}
): Utterance {
  const maxWords = options.maxWords ?? 3
  const gapSec = options.gapSec ?? 2

  if (!previousRemote || utterance.words.length === 0) return utterance
  if (utterance.start - previousRemote.end > gapSec) return utterance

  const normalize = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  // The tail of the other side's utterance: only that can stick.
  const tail = new Set(
    previousRemote.text
      .split(/\s+/)
      .slice(-5)
      .map(normalize)
      .filter(Boolean)
  )

  let drop = 0
  while (drop < Math.min(maxWords, utterance.words.length - 1)) {
    const word = utterance.words[drop]!
    if (!tail.has(normalize(word.text))) break

    // The second sign is the audio under the word. Either the microphone was
    // hearing the speakers at that moment, or there is no sound under the word at
    // all: recognition places times approximately, and a word that stuck often ends
    // up where the person was silent. A word of your own cannot look like that.
    const micLevel = levels.mic(word.start, word.end)
    const systemLevel = levels.system(word.start, word.end)
    const silent = micLevel < SPEECH_RMS_THRESHOLD
    if (!silent && micIsOwnVoice(micLevel, systemLevel)) break
    drop++
  }

  if (drop === 0) return utterance
  const words = utterance.words.slice(drop)
  return {
    ...utterance,
    words,
    start: words[0]!.start,
    text: words.map((w) => w.text).join(' ')
  }
}

/**
 * Keep only what the person said themselves in an utterance.
 *
 * A microphone utterance is often glued from two halves: first the other
 * side's echo from the speakers, then speech of your own. Judging it whole by
 * the average level will not do: on a real recording such an utterance gave a
 * ratio of 0.52 and was discarded entirely, even though its second half was
 * spoken in complete silence from the speakers and belonged to the person.
 *
 * So the decision is made per word: the ones kept are those under which the
 * microphone is louder than the speakers. Returns `null` if no speech of your
 * own is left.
 */
export function keepOwnVoice(
  utterance: Utterance,
  levels: { mic: (from: number, to: number) => number; system: (from: number, to: number) => number }
): Utterance | null {
  if (utterance.words.length === 0) {
    return micIsOwnVoice(
      levels.mic(utterance.start, utterance.end),
      levels.system(utterance.start, utterance.end)
    )
      ? utterance
      : null
  }

  // The speaker level is measured with a margin either side of the word: there
  // are short dips between the other side's words, and over a single word those
  // look like silence, letting echo pass for speech of your own. Your own speech
  // runs for seconds, and the margin does it no harm.
  const around = 0.5
  const mine = utterance.words.filter((word) =>
    micIsOwnVoice(
      levels.mic(word.start, word.end),
      levels.system(word.start - around, word.end + around)
    )
  )
  if (mine.length === 0) return null
  if (mine.length === utterance.words.length) return utterance

  // A scrap in the middle of someone else's speech is recognition noise rather
  // than an utterance: three garbled words on a line of their own are worse than
  // nothing. We look at both the word count and the duration: three words in half
  // a second is not speech.
  const spoken = mine[mine.length - 1]!.end - mine[0]!.start
  if (mine.length < 3 || spoken < 1) return null

  return {
    ...utterance,
    text: mine.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim(),
    words: mine,
    start: mine[0]!.start,
    end: mine[mine.length - 1]!.end
  }
}

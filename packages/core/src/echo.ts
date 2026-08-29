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

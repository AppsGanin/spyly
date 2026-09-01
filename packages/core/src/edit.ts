import type { Meeting, Utterance } from './types.js'

/**
 * What the transcript view needs beyond the text itself.
 *
 * Editing an utterance by hand was removed: the transcript is a record of what
 * was said, and correcting it made the file disagree with the audio next to it.
 * What is left is reading: the range that falls under a cut.
 */





/**
 * The utterances that fall inside the stretch being cut out.
 *
 * Ones that only touch the edge are removed whole: trimming a phrase by seconds
 * means leaving half a word in the transcript.
 */
export function utterancesInRange(meeting: Meeting, from: number, to: number): Utterance[] {
  const [a, b] = from <= to ? [from, to] : [to, from]
  return meeting.utterances.filter((u) => u.start < b && u.end > a)
}

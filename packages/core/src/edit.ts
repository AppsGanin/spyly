import type { Meeting, Utterance } from './types.js'

/**
 * What the transcript view needs beyond the text itself.
 *
 * Editing an utterance by hand was removed: the transcript is a record of what
 * was said, and correcting it made the file disagree with the audio next to it.
 * What is left is reading: the range under a cut, and the words the model was
 * unsure about.
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

/**
 * The doubt threshold for a particular recording.
 *
 * An absolute number does not work here: on a clean recording the model is
 * confident almost everywhere, on a noisy one nowhere, and a fixed threshold
 * either underlines nothing or underlines the whole text. We take the bottom
 * few per cent of this recording, so the highlighting always points at the
 * worst of what is there and stays rare.
 */
export function doubtThreshold(meeting: Pick<Meeting, 'utterances'>): number {
  const values: number[] = []
  for (const utterance of meeting.utterances) {
    for (const word of utterance.words) {
      if (typeof word.confidence === 'number') values.push(word.confidence)
    }
  }
  if (values.length < 20) return 0.6

  values.sort((a, b) => a - b)
  const at = values[Math.floor(values.length * 0.05)] ?? 0.6
  // Below 0.5 the doubt is obvious anyway, above 0.9 underlining is pointless:
  // the model is confident there, and the mistakes are of another kind.
  return Math.min(0.9, Math.max(0.5, at))
}

/** The words the model was unsure about. */
export function doubtfulWords(utterance: Utterance, threshold = 0.6): Set<number> {
  const out = new Set<number>()
  utterance.words.forEach((word, index) => {
    if (typeof word.confidence === 'number' && word.confidence < threshold) out.add(index)
  })
  return out
}

/**
 * How confident the model was about a whole utterance.
 *
 * Needed to show a list of doubtful places without walking the words in the
 * interface. Returns null when there is no confidence at all, which is the case
 * for live-mode drafts and for text edited by hand.
 */
export function utteranceConfidence(utterance: Utterance): number | null {
  const values = utterance.words.map((w) => w.confidence).filter((v): v is number => typeof v === 'number')
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

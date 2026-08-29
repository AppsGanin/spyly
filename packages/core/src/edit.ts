import type { Meeting, Utterance, Word } from './types.js'

/**
 * Editing the transcript: split, join, cut out.
 *
 * Voice separation goes wrong predictably: on interruptions two phrases stick
 * together into one, and one long phrase falls apart into two. A person has to
 * be the one to fix that, and to fix it quickly, so the operations live here,
 * apart from the interface, and are covered by tests.
 */

/** A moment inside an utterance by character position, in proportion to the text length. */
function timeAt(utterance: Utterance, charIndex: number): number {
  const { start, end, text, words } = utterance

  // When there are words with timestamps, we take the start of the first word
  // that falls into the second half: a linear estimate by characters lies more
  // the longer the utterance is.
  if (words.length > 0) {
    let at = 0
    for (const word of words) {
      if (at >= charIndex) return word.start
      at += word.text.length + 1
    }
    return words[words.length - 1]!.end
  }

  const ratio = text.length > 0 ? Math.min(1, Math.max(0, charIndex / text.length)) : 0
  return start + (end - start) * ratio
}

/**
 * A free identifier based on the original.
 *
 * A plain suffix will not do: splitting an utterance twice would give two
 * identical `u1b`, after which an edit would land on the wrong utterance and
 * React would render the list with duplicate keys.
 */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Splitting an utterance at the given place.
 *
 * Returns null when there is nothing to cut: an empty half is worse than a
 * refusal. `taken` are the identifiers already in use in this recording.
 */
export function splitUtterance(
  utterance: Utterance,
  charIndex: number,
  taken: ReadonlySet<string> = new Set()
): [Utterance, Utterance] | null {
  const head = utterance.text.slice(0, charIndex).trim()
  const tail = utterance.text.slice(charIndex).trim()
  if (!head || !tail) return null

  const at = Math.min(Math.max(timeAt(utterance, charIndex), utterance.start), utterance.end)
  const headWords: Word[] = utterance.words.filter((w) => w.start < at)
  const tailWords: Word[] = utterance.words.filter((w) => w.start >= at)

  return [
    { ...utterance, text: head, end: at, words: headWords },
    { ...utterance, id: uniqueId(`${utterance.id}b`, taken), text: tail, start: at, words: tailWords }
  ]
}

/**
 * Joining two neighbouring utterances.
 *
 * The speaker is taken from the first: joining usually happens because the
 * second half was attributed to somebody else by mistake.
 */
export function mergeUtterances(first: Utterance, second: Utterance): Utterance {
  return {
    ...first,
    text: `${first.text.trim()} ${second.text.trim()}`.trim(),
    start: Math.min(first.start, second.start),
    end: Math.max(first.end, second.end),
    words: [...first.words, ...second.words].sort((a, b) => a.start - b.start)
  }
}

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

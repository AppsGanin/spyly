/**
 * Breaking live text into phrases.
 *
 * Streaming recognition hands back a growing string: while a person speaks it
 * is extended from the end. Showing it as one lump will not do, as a monologue
 * turns into a paragraph half a minute long that cannot be read. So finished
 * sentences are released as lines of their own and only the last one grows.
 */

/**
 * The end of a finished sentence.
 *
 * A full stop on its own guarantees nothing: an abbreviation or an initial may
 * follow. But if the next word has already been spoken after it, the sentence
 * is certainly finished.
 *
 * Returns the position right after the mark of the first finished sentence, or
 * `null` if there are none yet. The first one specifically: one line is one
 * sentence, and the remainder is released on the next step.
 */
export function closedSentenceEnd(text: string): number | null {
  for (const match of text.matchAll(/[.!?…]+(?=\s+\S)/g)) {
    const end = match.index + match[0].length
    // A one-word scrap on a line of its own looks ragged: "Yes." is better shown
    // together with whatever follows it.
    if (text.slice(0, end).trim().split(/\s+/).length < 2) continue
    return end
  }
  return null
}

/**
 * Separate a finished phrase from the growing text.
 *
 * `whole` is the recognition result from the start of the stretch, `released`
 * is how many of its characters have already been shown as separate phrases.
 * Returns the phrase itself and the new value of `released`, or `null` if there
 * is nothing to release yet.
 */
export function releaseSentence(
  whole: string,
  released: number
): { sentence: string; released: number } | null {
  const rest = whole.slice(released).trim()
  if (!rest) return null
  const cut = closedSentenceEnd(rest)
  if (cut === null) return null
  return {
    sentence: rest.slice(0, cut).trim(),
    // The difference in lengths already includes everything handed out earlier
    // along with the spaces discarded, so the value is assigned rather than added:
    // adding counted what was handed out twice and ate the start of the next phrase.
    released: whole.length - rest.length + cut
  }
}

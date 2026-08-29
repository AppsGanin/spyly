/**
 * A term dictionary that learns from edits.
 *
 * If a person corrected a phonetic spelling to "Kubernetes" in a transcript,
 * the same word will be recognised wrongly next time too. Instead of making
 * them go to settings separately and type the term in by hand, the candidates
 * are pulled straight out of the edit.
 */

const WORD = /[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu

function words(text: string): string[] {
  return text.match(WORD) ?? []
}

/**
 * Words that appeared during an edit and look like a term.
 *
 * Deliberately cautious: better to suggest nothing than to clutter the
 * dictionary with ordinary words, since the dictionary goes into the hint for
 * the recogniser and starts getting in its way as it grows.
 */
export function learnedTerms(before: string, after: string, known: readonly string[] = []): string[] {
  const had = new Set(words(before).map((w) => w.toLowerCase()))
  const seen = new Set(known.map((w) => w.trim().toLowerCase()))
  const out: string[] = []

  for (const word of words(after)) {
    const key = word.toLowerCase()
    if (had.has(key) || seen.has(key)) continue
    seen.add(key)

    // A term is either a word with unusual spelling (capitals inside it, digits, a
    // hyphen, a full stop), or Latin letters among Cyrillic, or a name with a
    // capital. An ordinary lower-case Russian word does not count as a term.
    const hasInnerCaps = /\p{Lu}/u.test(word.slice(1))
    const hasDigitsOrPunct = /[\d._+-]/.test(word)
    const isLatin = /^[A-Za-z][A-Za-z\d._+-]*$/.test(word)
    const isCapitalized = /^\p{Lu}/u.test(word)

    if (word.length < 3) continue
    if (!(hasInnerCaps || hasDigitsOrPunct || isLatin || isCapitalized)) continue

    out.push(word)
  }
  return out
}

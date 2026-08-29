/**
 * Filtering out text the recogniser invented.
 *
 * Whisper was trained partly on subtitles, and on silence it emits the most
 * likely string from that training data: credits along the lines of "Subtitles
 * by DimaTorzok" or "Thanks for watching". Neither the `no-speech` threshold
 * nor suppressing non-speech tokens cures this: checked on whisper.cpp
 * large-v3, the phrase gets through at any values.
 *
 * The list is split in two, and that matters. Credits and names are looked for
 * as substrings: they cannot occur in live speech. Video sign-offs such as
 * "thanks for watching" are matched against the whole string, because a person
 * really can say that, and such an utterance must not be cut out of the middle
 * of a conversation.
 */

/** Credits and names: looked for as substrings, they produce no false positives. */
const SIGNATURES: string[] = [
  // Russian: subtitle author credits
  'dimatorzok',
  'dima torzok',
  'субтитры сделал',
  'субтитры создал',
  'субтитры создавал',
  'субтитры делал',
  'субтитры подготовил',
  'субтитры предоставил',
  'субтитры подогнал',
  'субтитры корректировал',
  'субтитры под редакцией',
  'редактор субтитров',
  'перевод и субтитры',
  'субтитры от amara',
  'алексей дубровский',

  // English
  'subtitles by',
  'amara.org',
  'transcription by',
  'subtitled by',
  'captions by',

  // The same bug in other languages, each with a name of its own
  'altyazı',
  'titulky vytvořil',
  'johnyx',
  'ترجمة نانسي قنقر',
  '字幕by',
  'untertitel der amara.org-community',
  'sous-titres réalisés par',
  'subtítulos realizados por la comunidad de amara.org',
  'legendas pela comunidade amara.org'
]

/**
 * Video sign-offs: matched against the whole string.
 *
 * A person can say "thanks" or "to be continued" and mean it, so these must not
 * be cut out of the middle of a conversation: only a full match counts.
 */
const CLOSINGS: string[] = [
  'продолжение следует',
  'спасибо за просмотр',
  'спасибо за внимание',
  'спасибо, что досмотрели до конца',
  'подписывайтесь на канал',
  'ставьте лайки и подписывайтесь',
  'не забудьте подписаться',
  'до новых встреч',
  'всем пока',

  'thank you',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'like and subscribe',
  'see you next time',
  'to be continued',
  'you',

  'gracias por ver el video',
  "merci d'avoir regardé cette vidéo",
  'vielen dank fürs zuschauen',
  'ご視聴ありがとうございました',
  '시청해 주셔서 감사합니다',
  '感谢观看',
  'kiitos',
  'kiitos kun katsoit'
]

/** What a list cannot express: a name with an initial, an empty string, housekeeping markers. */
const PATTERNS: RegExp[] = [
  // "Proofreader A. Egorova": the word "proofreader" on its own is legitimate in
  // speech, so only the whole credit is caught, initial included.
  /^корректор\s+[а-яё]\.?\s*[а-яё]*$/i,
  /^редактор\s+[а-яё]\.\s*[а-яё]*$/i,
  /^\[?\s*(music|applause|silence|blank[_\s]audio|музыка|аплодисменты)\s*\]?\.?$/i,
  /^[.．。…\s]*$/,
  /^(и|а|э|ы|the)\.?$/i
]

/** A string without surrounding punctuation and in lower case, for matching against the lists. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\s"«»'`(\[]+|[\s"«»'`)\].!?,;:…]+$/g, '')
    .trim()
}

/** Whether an utterance looks like something the model invented rather than real speech. */
export function isLikelyHallucination(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true

  const normalized = normalize(trimmed)
  if (!normalized) return true

  if (SIGNATURES.some((needle) => normalized.includes(needle))) return true
  if (CLOSINGS.includes(normalized)) return true
  if (PATTERNS.some((pattern) => pattern.test(trimmed))) return true

  return isRepetitionLoop(trimmed)
}

/**
 * Cut out subtitle credits, keeping the live speech.
 *
 * The credit sticks to the start or the end of an utterance, and all the rest
 * of the text used to go with it: on a real recording "Subtitles by DimaTorzok"
 * carried off thirty-seven seconds of conversation. We look for the credit up
 * to the end of the sentence and remove only that.
 *
 * Returns the cleaned text, or `null` if nothing meaningful is left after the
 * cut: there is no reason to show such an utterance.
 */
export function stripHallucination(text: string): string | null {
  let out = text.trim()
  if (!out) return null

  for (const needle of SIGNATURES) {
    for (;;) {
      const at = normalize(out).indexOf(needle)
      if (at === -1) break
      // The bounds are found in the original string: matching goes over the
      // normalised one, but what has to be cut is what a person will see.
      const span = matchSpan(out, needle)
      if (!span) break
      out = (out.slice(0, span.from) + ' ' + out.slice(span.to)).replace(/\s+/g, ' ').trim()
    }
  }

  if (!out) return null
  // A couple of words left is almost certainly a scrap of the credit, not speech.
  if (out.split(/\s+/).length < 3) return null
  return out
}

/**
 * The bounds of a credit in the original string.
 *
 * Matching goes over the normalised text while the original is what has to be
 * cut, so the end of the match is found by growing: we take the shortest piece
 * that, once normalised, matches the credit whole. Exactly that is cut out;
 * running to the end of the sentence will not do, as live speech is already
 * there.
 */
function matchSpan(text: string, needle: string): { from: number; to: number } | null {
  for (let from = 0; from < text.length; from++) {
    if (!normalize(text.slice(from, from + needle.length + 12)).startsWith(needle)) continue
    for (let to = from + 1; to <= Math.min(text.length, from + needle.length + 12); to++) {
      if (normalize(text.slice(from, to)) === needle) return { from, to }
    }
  }
  return null
}

/**
 * Looping output from the model.
 *
 * Whisper sometimes falls into repeating one phrase: "I don't know what that
 * means." thirty times in a row where nobody said anything of the kind. On a
 * real half-hour recording that made up more than half the transcript.
 *
 * We look for the shortest repeating group of words: if nearly the whole text
 * consists of it, this is the model stuck rather than speech. People do repeat
 * themselves, but not ten times in a row word for word.
 */
export function isRepetitionLoop(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  if (words.length < 6) return false
  if (new Set(words).size <= 2) return true

  // Up to 60% of the length: a phrase with a cut-off repeat takes a little over half.
  for (let unit = 1; unit <= Math.min(12, Math.floor(words.length * 0.6)); unit++) {
    const head = words.slice(0, unit)
    const headText = head.join(' ')
    let repeats = 0
    let covered = 0
    for (let at = 0; at + unit <= words.length; at += unit) {
      if (words.slice(at, at + unit).join(' ') !== headText) break
      repeats++
      covered += unit
    }
    if (repeats < 1) continue

    // The tail is often cut off halfway: the model stops in the middle of a phrase.
    const tail = words.slice(covered)
    const tailIsStart = tail.length > 0 && tail.every((word, i) => word === head[i])
    if (tailIsStart) covered += tail.length

    const share = covered / words.length
    if (repeats >= 3 && share > 0.7) return true
    // Two full repeats and a cut-off third is also a loop, but only for long
    // groups: "yes, yes" and "all right, all right" are things people say and mean.
    if (repeats === 2 && tailIsStart && unit >= 3 && share > 0.85) return true
    // A phrase and its cut-off repeat: "...what that means. ...what that".
    if (repeats === 1 && tailIsStart && unit >= 4 && tail.length >= 3 && share > 0.95) return true
  }
  return false
}

/** The energy threshold below which a stretch counts as silence and the text as invention. */
export const SILENCE_RMS_THRESHOLD = 0.006

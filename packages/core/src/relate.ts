import type { Meeting, MeetingMeta } from './types.js'

/**
 * Finding related recordings.
 *
 * One conversation rarely stands alone: a subject runs through several
 * meetings, and on opening a recording it helps to see straight away where the
 * same thing was discussed before. Closeness is computed from two signs: shared
 * participants and shared rare words.
 */

/** Words that occur in any conversation and therefore distinguish nothing. */
const STOP = new Set([
  'это', 'что', 'как', 'так', 'вот', 'там', 'тут', 'если', 'или', 'для', 'над', 'под', 'при',
  'она', 'они', 'оно', 'его', 'ему', 'нас', 'вам', 'нам', 'мне', 'меня', 'тебя', 'себя',
  'быть', 'есть', 'было', 'были', 'будет', 'буду', 'надо', 'нужно', 'можно', 'может',
  'да', 'нет', 'ну', 'вообще', 'просто', 'типа', 'короче', 'слушай', 'смотри', 'давай',
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'not', 'but'
])

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu) ?? []).filter((w) => !STOP.has(w))
}

/**
 * A crude word stem: the first six letters.
 *
 * Real lemmatisation would drag in a dictionary tens of megabytes long, while a
 * stump is enough for comparing subjects: the inflected forms of "billing" all
 * give the same thing, and different words rarely agree on their first six
 * letters.
 */
export function stem(word: string): string {
  return word.length > 6 ? word.slice(0, 6) : word
}

/**
 * The characteristic words of a recording: stem to the word as it was spoken.
 *
 * The example is needed so a person is shown "matched: billing, migration"
 * rather than stumps like "billin".
 */
export function meetingTerms(meeting: Meeting, limit = 60): Map<string, string> {
  const counts = new Map<string, number>()
  const examples = new Map<string, string>()
  for (const utterance of meeting.utterances) {
    for (const word of terms(utterance.text)) {
      const key = stem(word)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      // The shortest form is shown: it is usually the dictionary one.
      const known = examples.get(key)
      if (!known || word.length < known.length) examples.set(key, word)
    }
  }

  // A word spoken once is most often just a recogniser mishearing. But in a short
  // conversation almost nothing repeats, and discarding the singletons would
  // leave us with no words at all.
  let meaningful = [...counts.entries()].filter(([, count]) => count > 1)
  if (meaningful.length < 8) meaningful = [...counts.entries()]

  meaningful.sort((a, b) => b[1] - a[1])
  const out = new Map<string, string>()
  for (const [key] of meaningful.slice(0, limit)) out.set(key, examples.get(key) ?? key)
  return out
}

/** Who was in the conversation, as far as anything knows: the calendar. */
function names(meeting: Meeting): Set<string> {
  return new Set(meeting.calendarParticipants.map((name) => name.toLowerCase()))
}

function overlap(a: Iterable<string>, b: { has(key: string): boolean }, sizeA: number, sizeB: number): number {
  if (sizeA === 0 || sizeB === 0) return 0
  let shared = 0
  for (const value of a) if (b.has(value)) shared++
  return shared / Math.min(sizeA, sizeB)
}

export interface Related {
  meeting: MeetingMeta
  /** 0..1, how similar the recordings are. */
  score: number
  /** What exactly matched: shown to a person rather than a bare number. */
  sharedTerms: string[]
  sharedPeople: string[]
}

/**
 * Recordings similar to this one.
 *
 * The threshold is deliberately high: a false link saying "this continues
 * yesterday's" is worse than none, as it leads the wrong way.
 */
export function relatedMeetings(
  meeting: Meeting,
  others: readonly Meeting[],
  options: {
    limit?: number
    minScore?: number
    /**
     * Where to take a recording's words from. Parsing the transcript is the most
     * expensive part, and the caller usually holds it in a cache already.
     */
    termsOf?: (meeting: Meeting) => Map<string, string>
  } = {}
): Related[] {
  const { limit = 3, minScore = 0.25, termsOf = meetingTerms } = options
  const myTerms = termsOf(meeting)
  const myNames = names(meeting)

  const out: Related[] = []
  for (const other of others) {
    if (other.id === meeting.id) continue
    const theirTerms = termsOf(other)
    const theirNames = names(other)

    const shared = [...myTerms.entries()].filter(([key]) => theirTerms.has(key)).map(([, word]) => word)
    const people = [...myNames].filter((n) => theirNames.has(n))

    // Words weigh more than people: the same colleagues turn up in every
    // conversation, while shared terminology is a sign of a shared subject.
    const score =
      overlap(myTerms.keys(), theirTerms, myTerms.size, theirTerms.size) * 0.75 +
      overlap(myNames, theirNames, myNames.size, theirNames.size) * 0.25
    if (score < minScore || shared.length < 3) continue

    const { speakers, utterances, summary, ...meta } = other
    out.push({ meeting: meta, score, sharedTerms: shared.slice(0, 6), sharedPeople: people })
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

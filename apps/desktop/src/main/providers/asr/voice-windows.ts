import type { Word } from '@spyly/core'

/**
 * Cutting speech for a model that only hears short stretches of it.
 *
 * GigaAM was trained on phrases, not hours: handed two minutes at once it gets
 * the first fifteen seconds right and the rest turns to mush ("Помаешь мыль…
 * этот пут… былмвать" on a real recording). Its authors cut long audio at the
 * pauses and recognise the pieces one by one, and so do we.
 *
 * The pieces are not the detector's own, though. Those are single phrases, a
 * second or two long, and a phrase on its own is too little for the model: at
 * 0.3 seconds of silence a cut lost "скажем так" outright and "Мише" came out
 * as "Миша". So neighbouring phrases are put back together into windows, and
 * the model sees whole sentences with the pauses between them.
 */

/** Where speech is, in seconds. */
export interface Span {
  start: number
  end: number
}

/**
 * The longest window handed to the model.
 *
 * The model's own limit is twenty-five seconds; a little is left in hand, as
 * the detector's phrases end where the speech does, not where we would like.
 */
export const WINDOW_MAX_SEC = 20

/**
 * A pause that always ends a window.
 *
 * Over a second of silence is a finished thought far more often than not, and
 * giving the model seconds of nothing to chew on gains nothing.
 */
export const WINDOW_BREAK_SEC = 1

/**
 * Put the detector's phrases together into windows the model can take.
 *
 * Phrases join while the window stays within the limit and the pause before
 * the next one is short. A single phrase longer than the limit stays as it is:
 * the detector itself is told not to produce those, and cutting one mid-word
 * would be worse than a window a second too long.
 */
export function windowsFromSpeech(
  phrases: readonly Span[],
  maxSec = WINDOW_MAX_SEC,
  breakSec = WINDOW_BREAK_SEC
): Span[] {
  const out: Span[] = []
  let current: Span | null = null
  for (const phrase of phrases) {
    if (current && phrase.start - current.end < breakSec && phrase.end - current.start <= maxSec) {
      current.end = phrase.end
      continue
    }
    if (current) out.push(current)
    current = { start: phrase.start, end: phrase.end }
  }
  if (current) out.push(current)
  return out
}

/**
 * How long the last piece of a word sounds after the moment it is emitted.
 *
 * The model marks when a piece of a word appears, not when it stops. Taking the
 * next word's start as this one's end would leave no gap anywhere, and gaps are
 * what the transcript splits utterances on: a pause in the middle of a window
 * would vanish and two thoughts would be glued together.
 */
const TAIL_SEC = 0.15

/**
 * Words out of the model's pieces, each with its own time.
 *
 * A piece starting with a space starts a word; a piece that is only a space
 * ends one. The text is cut back into words on whitespace and every word takes
 * the time of the piece its first letter came from — so the words are exactly
 * the text the model produced, and the times are the model's own.
 *
 * `offset` is where the window starts in the recording, `limit` where it ends.
 * Null when the pieces and the times do not line up, which leaves it to the
 * caller to place the words some other way.
 */
export function wordsFromTokens(
  tokens: readonly string[],
  times: readonly number[],
  offset: number,
  limit: number
): Word[] | null {
  if (tokens.length === 0 || tokens.length !== times.length) return null

  let text = ''
  const owner: number[] = []
  for (const [index, token] of tokens.entries()) {
    text += token
    for (let k = 0; k < token.length; k++) owner.push(index)
  }

  const spans: { text: string; first: number; last: number }[] = []
  for (const match of text.matchAll(/\S+/g)) {
    const at = match.index
    spans.push({ text: tidy(match[0]), first: owner[at]!, last: owner[at + match[0].length - 1]! })
  }

  return spans.map((span, i) => {
    const start = offset + times[span.first]!
    const next = spans[i + 1]
    const ceiling = next ? offset + times[next.first]! : limit
    const end = Math.max(start, Math.min(ceiling, offset + times[span.last]! + TAIL_SEC))
    return { text: span.text, start, end }
  })
}

/**
 * The model now and then ends a sentence with two full stops ("добавим..").
 * Two become one; three are an ellipsis and are left alone.
 */
function tidy(word: string): string {
  return word.replace(/(?<!\.)\.\.(?!\.)/g, '.')
}

/** Ends a sentence, or at least says the thought goes on. */
const CLOSED = /[.!?…,;:—–-]["»”)]*$/

/**
 * Join the windows' words into one stream.
 *
 * Inside a window the model punctuates by itself. At the edge it does not: the
 * last sentence of a window comes out without its full stop, and the model
 * also writes the first word of every window with a capital whether or not a
 * sentence begins there. So a capital at a seam says nothing, and the pause
 * does: after a real one the full stop is put back, after a short one — where
 * the window was cut only because it was full — the text is left as it is, as
 * a missing stop is a smaller harm than one in the middle of a sentence.
 */
export function joinWindows(windows: readonly Word[][], breakSec = WINDOW_BREAK_SEC): Word[] {
  const out: Word[] = []
  for (const words of windows) {
    if (words.length === 0) continue
    const last = out[out.length - 1]
    if (last && words[0]!.start - last.end >= breakSec && !CLOSED.test(last.text)) {
      out[out.length - 1] = { ...last, text: `${last.text}.` }
    }
    out.push(...words)
  }
  const last = out[out.length - 1]
  // The very end of the recording is the end of a sentence too.
  if (last && !CLOSED.test(last.text)) out[out.length - 1] = { ...last, text: `${last.text}.` }
  return out
}

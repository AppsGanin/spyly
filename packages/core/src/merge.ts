import type { AsrResult, AsrSegment, Meeting, SpeakerTurn, TrackId, Utterance, Word } from './types.js'

/** The length of the overlap between two stretches. Zero if they do not overlap. */
export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/** The pause after which one person's utterance is broken into two. */
/**
 * The length after which an utterance has to be split.
 *
 * The split goes not at the counter but at the nearest end of a sentence after
 * it: breaking mid-word is worse than showing an utterance slightly longer.
 */
const UTTERANCE_MAX_SEC = 35

const UTTERANCE_GAP_SEC = 1.5

/**
 * The cluster a stretch belongs to: the one it overlaps most. If there is no
 * overlap at all (the word fell into a diarization pause), the nearest stretch
 * in time is taken, or the word would be lost.
 */
export function clusterFor(start: number, end: number, turns: readonly SpeakerTurn[]): number | null {
  if (turns.length === 0) return null

  let bestCluster: number | null = null
  let bestOverlap = 0
  for (const t of turns) {
    const o = overlap(start, end, t.start, t.end)
    if (o > bestOverlap) {
      bestOverlap = o
      bestCluster = t.cluster
    }
  }
  if (bestCluster !== null) return bestCluster

  let nearest: SpeakerTurn | null = null
  let nearestDist = Infinity
  const mid = (start + end) / 2
  for (const t of turns) {
    const dist = mid < t.start ? t.start - mid : mid > t.end ? mid - t.end : 0
    if (dist < nearestDist) {
      nearestDist = dist
      nearest = t
    }
  }
  return nearest ? nearest.cluster : null
}

/** The words of a segment; if ASR gave no per-word timestamps, the segment itself as one "word". */
/**
 * The longest a single drawn-out word lasts.
 *
 * Recognition stretches the last words of a stretch out to its end: on a real
 * recording two short words got 3.5 seconds each and covered ten seconds of
 * silence. Because of that no pauses were left between words, an utterance was
 * glued together across the silence and took someone else's time in the
 * statistics.
 */
const MAX_WORD_SEC = 2

function wordsOf(seg: AsrSegment): Word[] {
  const words =
    seg.words.length > 0 ? seg.words : [{ text: seg.text.trim(), start: seg.start, end: seg.end }]
  // A whole utterance as a single "word" is not clamped: its duration is meaningful there.
  if (words.length < 2) return words
  return words.map((w) =>
    w.end - w.start > MAX_WORD_SEC ? { ...w, end: w.start + MAX_WORD_SEC } : w
  )
}

/** Joining text with an eye on punctuation: no space is needed before a full stop or a comma. */
function joinWords(words: readonly Word[]): string {
  let out = ''
  for (const w of words) {
    const t = w.text.trim()
    if (!t) continue
    if (out === '') out = t
    else if (/^[,.!?;:)\]}»…]/.test(t)) out += t
    else if (/[(\[{«]$/.test(out)) out += t
    else out += ' ' + t
  }
  return out
}

/**
 * Lay the ASR result of one track out by speaker.
 *
 * Every word gets a cluster by its largest overlap with the diarization
 * stretches, and then consecutive words of one cluster are collected into an
 * utterance. An utterance breaks on a change of cluster and on a pause longer
 * than UTTERANCE_GAP_SEC.
 */
export function assignSpeakers(
  asr: AsrResult,
  turns: readonly SpeakerTurn[],
  opts: { provisional?: boolean; idPrefix?: string } = {}
): Utterance[] {
  const track: TrackId = asr.track
  const prefix = opts.idPrefix ?? track
  const provisional = opts.provisional ?? false

  const all: Word[] = []
  for (const seg of asr.segments) {
    for (const w of wordsOf(seg)) {
      if (w.text.trim()) all.push(w)
    }
  }
  all.sort((a, b) => a.start - b.start || a.end - b.end)

  const out: Utterance[] = []
  let bucket: Word[] = []
  let bucketCluster = 0
  let counter = 0

  const flush = () => {
    if (bucket.length === 0) return
    const first = bucket[0]!
    const last = bucket[bucket.length - 1]!
    const text = joinWords(bucket)
    if (text) {
      out.push({
        id: `${prefix}-${counter++}`,
        speakerId: `${track}:${bucketCluster}`,
        track,
        start: first.start,
        end: last.end,
        text,
        words: bucket,
        provisional
      })
    }
    bucket = []
  }

  for (const w of all) {
    // With no diarization the whole track counts as one speaker.
    const cluster = clusterFor(w.start, w.end, turns) ?? 0
    if (bucket.length === 0) {
      bucketCluster = cluster
      bucket.push(w)
      continue
    }
    const prev = bucket[bucket.length - 1]!
    const gap = w.start - prev.end
    if (cluster !== bucketCluster || gap > UTTERANCE_GAP_SEC) {
      flush()
      bucketCluster = cluster
    } else if (
      // One person can speak without pauses for minutes, and then an utterance grows
      // into a wall of text that can neither be read nor quoted. We split at the end
      // of a sentence, but only once the utterance is already long, so as not to
      // break an ordinary conversation into scraps.
      prev.end - bucket[0]!.start > UTTERANCE_MAX_SEC &&
      /[.!?…]$/.test(prev.text.trim())
    ) {
      flush()
      bucketCluster = cluster
    }
    bucket.push(w)
  }
  flush()

  return out
}

/**
 * Merge the tracks into one feed. Cross-track speaker merging is not needed: a
 * person cannot physically be in the room and on the other end of the call at
 * the same time.
 */
export function mergeTracks(...tracks: readonly Utterance[][]): Utterance[] {
  const all = tracks.flat()
  all.sort((a, b) => a.start - b.start || a.end - b.end || a.track.localeCompare(b.track))
  return all
}

/** Every speaker identifier that actually occurs in the utterances. */
export function usedSpeakerIds(utterances: readonly Utterance[]): string[] {
  const seen = new Set<string>()
  for (const u of utterances) seen.add(u.speakerId)
  return [...seen].sort()
}

/** How much each person spoke, for sorting the participant list and picking the "main" one. */
export function speakingTime(utterances: readonly Utterance[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const u of utterances) {
    m.set(u.speakerId, (m.get(u.speakerId) ?? 0) + Math.max(0, u.end - u.start))
  }
  return m
}

/** Normalisation for comparing text: case, punctuation and the ё/е distinction do not matter. */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The share of shared words, steadier against ASR slips than a character-by-character comparison. */
export function textSimilarity(a: string, b: string): number {
  const left = normalizeForCompare(a).split(' ').filter(Boolean)
  const right = normalizeForCompare(b).split(' ').filter(Boolean)
  if (left.length === 0 || right.length === 0) return 0

  const counts = new Map<string, number>()
  for (const word of left) counts.set(word, (counts.get(word) ?? 0) + 1)
  let shared = 0
  for (const word of right) {
    const left = counts.get(word) ?? 0
    if (left > 0) {
      shared++
      counts.set(word, left - 1)
    }
  }
  return (2 * shared) / (left.length + right.length)
}

/** The share of `part`'s words that occur in `whole`. */
export function containment(part: string, whole: string): number {
  const partWords = normalizeForCompare(part).split(' ').filter(Boolean)
  const wholeWords = normalizeForCompare(whole).split(' ').filter(Boolean)
  if (partWords.length === 0) return 0

  const counts = new Map<string, number>()
  for (const word of wholeWords) counts.set(word, (counts.get(word) ?? 0) + 1)

  let found = 0
  for (const word of partWords) {
    const left = counts.get(word) ?? 0
    if (left > 0) {
      found++
      counts.set(word, left - 1)
    }
  }
  return found / partWords.length
}

export const ECHO_CONTAINMENT_THRESHOLD = 0.7
/** How far from a microphone utterance we look for its source in the system track. */
export const ECHO_TIME_TOLERANCE_SEC = 2.5
/** Utterances shorter than this are not judged by words: "yes" and "uh-huh" match anything. */
export const ECHO_MIN_WORDS = 3
/** How closely in time a short utterance has to occur to count as echo. */
export const SHORT_ECHO_WINDOW_SEC = 0.8
/** This many leading letters have to match for a scrap to count as the stump of someone else's word. */
const ECHO_PREFIX_LEN = 4

/**
 * Whether a short word looks like the stump of a word from someone else's speech.
 *
 * Speaker echo is recognised worse than the original, and only the beginning of
 * a word survives: a long word comes back as its first syllables. An exact
 * match will not catch that.
 */
function looksLikeFragmentOf(word: string, text: string): boolean {
  const needle = normalizeForCompare(word)
  if (needle.length < ECHO_PREFIX_LEN) return false
  const prefix = needle.slice(0, ECHO_PREFIX_LEN)
  return normalizeForCompare(text)
    .split(' ')
    .some((other) => other.length >= ECHO_PREFIX_LEN && other.startsWith(prefix))
}

/**
 * Remove speaker echo from the microphone track.
 *
 * If a person sits without headphones, the microphone hears the other side
 * through the speakers, and the same phrase lands in the transcript twice: once
 * as a remote participant, once as somebody "in the room".
 *
 * We compare not utterance against utterance but the microphone utterance
 * against the text of the system track over the same time: recognition and
 * voice separation cut the tracks up differently, and a phrase-by-phrase
 * comparison misses exactly where the boundaries did not line up.
 *
 * The user's own speech is untouched by this: it is not in the system track and
 * has nothing to match against. Very short utterances ("yes", "mhm") are left
 * alone entirely, as they match anything by chance.
 */
export function suppressEcho(
  micUtterances: readonly Utterance[],
  systemUtterances: readonly Utterance[],
  options: { containment?: number; tolerance?: number; minWords?: number } = {}
): Utterance[] {
  if (systemUtterances.length === 0) return [...micUtterances]
  const minContainment = options.containment ?? ECHO_CONTAINMENT_THRESHOLD
  const tolerance = options.tolerance ?? ECHO_TIME_TOLERANCE_SEC
  const minWords = options.minWords ?? ECHO_MIN_WORDS

  return micUtterances.filter((mic) => {
    const words = mic.text.trim().split(/\s+/).filter(Boolean)

    const from = mic.start - tolerance
    const to = mic.end + tolerance
    const nearby = systemUtterances.filter((system) => system.end >= from && system.start <= to)
    if (nearby.length === 0) return true

    // Very short utterances are not judged by words: "yes" and "uh-huh" match
    // anything by chance. The exception is when a phrase repeats the whole start of
    // somebody else's at almost the same moment: that is what an echo of the first
    // word looks like.
    if (words.length < minWords) {
      const echoed = nearby.some((system) => {
        const simultaneous = Math.abs(system.start - mic.start) <= SHORT_ECHO_WINDOW_SEC
        if (simultaneous && containment(mic.text, system.text) === 1) return true
        // The stump of someone else's word on top of their speech still going on.
        const inside = mic.start >= system.start - SHORT_ECHO_WINDOW_SEC && mic.start <= system.end
        return inside && words.every((word) => looksLikeFragmentOf(word, system.text))
      })
      return !echoed
    }

    const nearbyText = nearby.map((system) => system.text).join(' ')
    return containment(mic.text, nearbyText) < minContainment
  })
}

export interface SpeakingShare {
  speakerId: string
  seconds: number
  /** The share of all the time that was spoken, 0..1. */
  share: number
  utterances: number
}

/**
 * Who talked how much.
 *
 * Computed over the utterances rather than the length of the recording: pauses
 * and silence belong to nobody, and counting them into a share would be wrong.
 */
export function speakingShares(utterances: readonly Utterance[]): SpeakingShare[] {
  const seconds = new Map<string, number>()
  const counts = new Map<string, number>()
  for (const u of utterances) {
    const length = Math.max(0, u.end - u.start)
    seconds.set(u.speakerId, (seconds.get(u.speakerId) ?? 0) + length)
    counts.set(u.speakerId, (counts.get(u.speakerId) ?? 0) + 1)
  }
  const total = [...seconds.values()].reduce((a, b) => a + b, 0)
  return [...seconds.entries()]
    .map(([speakerId, value]) => ({
      speakerId,
      seconds: value,
      share: total > 0 ? value / total : 0,
      utterances: counts.get(speakerId) ?? 0
    }))
    .sort((a, b) => b.seconds - a.seconds)
}

/**
 * Rebuild a recognition result out of a transcript that already exists.
 *
 * Needed when processing is restarted from somewhere other than the beginning:
 * the words with their times sit in the utterances themselves, and speech can be
 * laid out by speaker again from those without transcribing the audio a second
 * time. Without this, rebuilding "from voice separation" assembled the
 * transcript out of nothing and erased it.
 *
 * For utterances with no per-word markup the text is taken whole: accuracy
 * inside the utterance is lost, but the utterance itself stays where it is.
 */
export function asrFromUtterances(
  utterances: readonly Utterance[],
  language: string
): AsrResult[] {
  const byTrack = new Map<TrackId, Word[]>()
  for (const utterance of utterances) {
    const words = byTrack.get(utterance.track) ?? []
    if (utterance.words.length > 0) words.push(...utterance.words)
    else words.push({ text: utterance.text, start: utterance.start, end: utterance.end })
    byTrack.set(utterance.track, words)
  }

  return [...byTrack.entries()].map(([track, words]) => {
    const sorted = [...words].sort((a, b) => a.start - b.start)
    return {
      track,
      language,
      segments: [
        {
          start: sorted[0]?.start ?? 0,
          end: sorted[sorted.length - 1]?.end ?? 0,
          text: sorted.map((w) => w.text).join(' '),
          words: sorted
        }
      ]
    }
  })
}

/**
 * Merge two participants into one.
 *
 * Voice separation sometimes breaks one person's speech into several clusters:
 * part said louder, part over the other side. The person then sits in the list
 * twice and their share of the conversation is halved. The utterances of the
 * one disappearing pass to the one that stays, and their order does not change.
 */
export function mergeSpeakers(meeting: Meeting, fromId: string, toId: string): Meeting {
  if (fromId === toId) return meeting
  if (!meeting.speakers.some((s) => s.id === toId)) return meeting

  return {
    ...meeting,
    speakers: meeting.speakers.filter((s) => s.id !== fromId),
    utterances: meeting.utterances.map((u) => (u.speakerId === fromId ? { ...u, speakerId: toId } : u))
  }
}

import { statSync } from 'node:fs'
import { meetingTerms, relatedMeetings, type Meeting, type Related } from '@spyly/core'
import { listMeetings, readMeeting } from './meetings.js'
import { meetingFile } from './paths.js'

/**
 * Finding similar recordings, remembering the words already parsed.
 *
 * Done naively this is expensive: the recording page is opened often, and
 * finding similar ones means reading the transcripts of every neighbour. Over
 * a month of use the archive grows to hundreds of megabytes, and the window
 * would freeze on every open.
 *
 * A recording's words only change together with its transcript file, so they
 * are stored with the file's timestamp and only the changed ones are read again.
 */
interface Cached {
  mtimeMs: number
  meeting: Meeting
  /** The parsed words, the most expensive part of the comparison. */
  terms: Map<string, string>
}

const cache = new Map<string, Cached>()

/** How many recordings back we look: further into the past the links are nearly always false. */
const LOOKBACK = 50

function mtimeOf(id: string): number {
  try {
    return statSync(meetingFile(id, 'transcript.json')).mtimeMs
  } catch {
    return 0
  }
}

async function load(id: string): Promise<Cached | null> {
  const mtime = mtimeOf(id)
  const hit = cache.get(id)
  if (hit && hit.mtimeMs === mtime) return hit

  const meeting = await readMeeting(id)
  if (!meeting) {
    cache.delete(id)
    return null
  }
  const entry: Cached = { mtimeMs: mtime, meeting, terms: meetingTerms(meeting) }
  cache.set(id, entry)
  return entry
}

export async function findRelated(id: string): Promise<Related[]> {
  const subject = await load(id)
  if (!subject) return []

  const others: Meeting[] = []
  const terms = new Map<string, Map<string, string>>([[id, subject.terms]])
  for (const meta of (await listMeetings()).slice(0, LOOKBACK)) {
    if (meta.id === id) continue
    const entry = await load(meta.id)
    if (!entry) continue
    others.push(entry.meeting)
    terms.set(meta.id, entry.terms)
  }

  return relatedMeetings(subject.meeting, others, {
    termsOf: (m) => terms.get(m.id) ?? meetingTerms(m)
  })
}

/** The recording was deleted or changed, so we forget it. */
export function forgetRelated(id: string): void {
  cache.delete(id)
}

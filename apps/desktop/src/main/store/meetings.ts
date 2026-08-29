import { existsSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { t,
  Meeting,
  MeetingMeta,
  renderSummaryMarkdown,
  renderTranscriptMarkdown,
  type Speaker,
  type Summary,
  type Utterance
} from '@spyly/core'
import { audioFile, ensureMeetingDirs, meetingDir, meetingFile, meetingsDir } from './paths.js'

/**
 * Files are the source of truth, with no database on top of them.
 *
 * A meeting folder can be copied, put in the cloud or handed to an agent
 * directly; the application will always be able to read it back.
 */

interface TranscriptFile {
  speakers: Speaker[]
  utterances: Utterance[]
  summary?: Summary
}

export async function listMeetingIds(): Promise<string[]> {
  const dir = meetingsDir()
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse()
}

export async function readMeta(id: string): Promise<MeetingMeta | null> {
  const file = meetingFile(id, 'meta.json')
  if (!existsSync(file)) return null
  try {
    const parsed = MeetingMeta.safeParse(JSON.parse(await readFile(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function writeMeta(meta: MeetingMeta): Promise<void> {
  await ensureMeetingDirs(meta.id)
  // Run through the schema: otherwise a whole meeting passed in by accident
  // drags another copy of the transcript into meta.json, and that is megabytes
  // on a long recording.
  const clean = MeetingMeta.parse(meta)
  await writeFile(meetingFile(meta.id, 'meta.json'), JSON.stringify(clean, null, 2), 'utf8')
}

export async function readTranscript(id: string): Promise<TranscriptFile> {
  const file = meetingFile(id, 'transcript.json')
  if (!existsSync(file)) return { speakers: [], utterances: [] }
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as TranscriptFile
    return { speakers: raw.speakers ?? [], utterances: raw.utterances ?? [], summary: raw.summary }
  } catch {
    return { speakers: [], utterances: [] }
  }
}

export async function readMeeting(id: string): Promise<Meeting | null> {
  const meta = await readMeta(id)
  if (!meta) return null
  const transcript = await readTranscript(id)
  const parsed = Meeting.safeParse({ ...meta, ...transcript })
  return parsed.success ? parsed.data : null
}

/** Save a meeting whole: JSON is canonical, markdown is derived for people and agents. */
export async function writeMeeting(meeting: Meeting): Promise<void> {
  await ensureMeetingDirs(meeting.id)
  const { speakers, utterances, summary, ...meta } = meeting
  await writeMeta(meta)
  await writeFile(
    meetingFile(meeting.id, 'transcript.json'),
    JSON.stringify({ speakers, utterances, summary }, null, 2),
    'utf8'
  )
  await writeFile(meetingFile(meeting.id, 'transcript.md'), renderTranscriptMarkdown(meeting), 'utf8')
  if (summary) {
    await writeFile(meetingFile(meeting.id, 'summary.md'), renderSummaryMarkdown(meeting), 'utf8')
  }
}

/**
 * Folders where the audio is present but meta.json cannot be read.
 *
 * Without this a recording simply disappears from the list: the file is
 * damaged, so as far as the application is concerned it does not exist. For a
 * person, though, their conversation is right there on disk, and hiding it
 * silently will not do.
 */
export async function findBrokenMeetings(): Promise<string[]> {
  const out: string[] = []
  for (const id of await listMeetingIds()) {
    if (await readMeta(id)) continue
    const hasSound = (['mic', 'system'] as const).some((track) => existsSync(audioFile(id, track)))
    if (hasSound) out.push(id)
  }
  return out
}

/**
 * Editing a recording whole, one edit at a time.
 *
 * Reading, changing and writing without a lock will not do: a person edits the
 * summary, an agent appends tasks over MCP, and at the same time the pipeline
 * saves the result of a stage. Without a queue two edits started together
 * leave the one that finished later, and the other vanishes silently.
 */
const locks = new Map<string, Promise<unknown>>()

export async function updateMeeting(id: string, change: (meeting: Meeting) => Meeting): Promise<Meeting> {
  const previous = locks.get(id) ?? Promise.resolve()
  const next = previous.then(async () => {
    const meeting = await readMeeting(id)
    if (!meeting) throw new Error(t('запись не найдена'))
    const updated = change(meeting)
    await writeMeeting(updated)
    return updated
  })
  // The tail of the queue must not break over one failed edit: the next one in
  // line has to get its turn regardless.
  locks.set(id, next.catch(() => undefined))
  return next
}

export async function listMeetings(): Promise<MeetingMeta[]> {
  const ids = await listMeetingIds()
  const metas = await Promise.all(ids.map(readMeta))
  const list = metas.filter((m): m is MeetingMeta => m !== null)
  // A folder name starts with the date, but within one day the order in it is
  // arbitrary: sorting has to be by the actual start time.
  list.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  return list
}

export async function deleteMeeting(id: string): Promise<void> {
  const dir = meetingDir(id)
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true })
}

export function hasAudio(id: string, track: 'mic' | 'system' | 'mix'): boolean {
  return existsSync(audioFile(id, track))
}

/**
 * Plain full-text search straight over the files.
 *
 * A database on top of this starts to make sense once there are thousands of
 * meetings; for now reading a hundred JSON files is faster than any
 * synchronisation of an index with the files.
 */
export async function searchMeetings(query: string): Promise<{ meeting: MeetingMeta; snippet: string }[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const ids = await listMeetingIds()
  const results: { meeting: MeetingMeta; snippet: string }[] = []

  for (const id of ids) {
    const meta = await readMeta(id)
    if (!meta) continue
    if (meta.title.toLowerCase().includes(needle)) {
      results.push({ meeting: meta, snippet: meta.title })
      continue
    }
    const transcript = await readTranscript(id)
    const hit = transcript.utterances.find((u) => u.text.toLowerCase().includes(needle))
    if (hit) {
      const at = hit.text.toLowerCase().indexOf(needle)
      const from = Math.max(0, at - 60)
      const snippet = (from > 0 ? '…' : '') + hit.text.slice(from, at + needle.length + 80).trim() + '…'
      results.push({ meeting: meta, snippet })
    }
  }
  return results
}

/** Meetings left in the "recording" state after the application crashed. */
export async function findOrphanedRecordings(): Promise<MeetingMeta[]> {
  const metas = await listMeetings()
  return metas.filter((m) => m.stages.recording === 'running')
}

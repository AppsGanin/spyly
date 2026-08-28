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
 * Файлы — источник правды, никакой базы поверх них.
 *
 * Папку со встречей можно скопировать, положить в облако или отдать агенту
 * напрямую; приложение всегда сможет её перечитать.
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
  // Прогоняем через схему: иначе случайно переданная целая встреча утащит в
  // meta.json ещё одну копию расшифровки, а это мегабайты на длинной записи.
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

/** Сохранить встречу целиком: JSON — канон, markdown — производные для людей и агентов. */
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
 * Папки, где звук есть, а meta.json нечитаем.
 *
 * Без этого запись просто исчезает из списка: файл повреждён — значит, для
 * приложения её нет. Для человека же на диске лежит его разговор, и молча
 * прятать его нельзя.
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
 * Правка записи целиком, по одной за раз.
 *
 * Читать, менять и писать без замка нельзя: конспект правит человек, задачи
 * дописывает агент через MCP, а конвейер в это же время сохраняет результат
 * этапа. Без очереди две правки, начатые одновременно, дают ту, что закончилась
 * позже, — вторая пропадает молча.
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
  // Хвост очереди не должен рваться из-за одной неудачной правки: следующая
  // в очереди обязана дождаться своего хода в любом случае.
  locks.set(id, next.catch(() => undefined))
  return next
}

export async function listMeetings(): Promise<MeetingMeta[]> {
  const ids = await listMeetingIds()
  const metas = await Promise.all(ids.map(readMeta))
  const list = metas.filter((m): m is MeetingMeta => m !== null)
  // Имя папки начинается с даты, но внутри одного дня порядок в нём случайный:
  // сортировать нужно по фактическому времени начала.
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
 * Простой полнотекстовый поиск прямо по файлам.
 *
 * Базу поверх этого имеет смысл заводить, когда встреч станут тысячи; пока
 * чтение сотни JSON быстрее, чем любая синхронизация индекса с файлами.
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

/** Встречи, оставшиеся в статусе «идёт запись» после падения приложения. */
export async function findOrphanedRecordings(): Promise<MeetingMeta[]> {
  const metas = await listMeetings()
  return metas.filter((m) => m.stages.recording === 'running')
}

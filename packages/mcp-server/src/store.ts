import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  Meeting,
  MeetingMeta,
  renderSummaryMarkdown,
  type Speaker,
  type Summary,
  type Utterance
} from '@spyly/core'

/**
 * Чтение хранилища Spyly напрямую с диска.
 *
 * Сервер намеренно не ходит в приложение: встречи должны быть доступны агенту
 * и когда Spyly закрыт.
 */
export function storageRoot(): string {
  return process.env.SPYLY_DIR || path.join(os.homedir(), 'Spyly')
}

function meetingsDir(): string {
  return path.join(storageRoot(), 'meetings')
}

export async function listMeetingIds(): Promise<string[]> {
  const dir = meetingsDir()
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()
}

export async function readMeta(id: string): Promise<MeetingMeta | null> {
  const file = path.join(meetingsDir(), id, 'meta.json')
  if (!existsSync(file)) return null
  try {
    const parsed = MeetingMeta.safeParse(JSON.parse(await readFile(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function readMeeting(id: string): Promise<Meeting | null> {
  const meta = await readMeta(id)
  if (!meta) return null
  const file = path.join(meetingsDir(), id, 'transcript.json')
  let extra: { speakers: Speaker[]; utterances: Utterance[]; summary?: Summary } = { speakers: [], utterances: [] }
  if (existsSync(file)) {
    try {
      extra = JSON.parse(await readFile(file, 'utf8')) as typeof extra
    } catch {
      // Битая расшифровка не должна прятать саму встречу от агента.
    }
  }
  const parsed = Meeting.safeParse({ ...meta, ...extra })
  return parsed.success ? parsed.data : null
}

export async function listMeetings(limit = 50): Promise<MeetingMeta[]> {
  const ids = await listMeetingIds()
  const all: MeetingMeta[] = []
  for (const id of ids) {
    const meta = await readMeta(id)
    if (meta) all.push(meta)
  }
  // Имя папки начинается с даты, но внутри одного дня порядок в нём случайный:
  // сортировать нужно по фактическому времени начала.
  all.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  return all.slice(0, limit)
}

/**
 * Все записи разом, от новых к старым.
 *
 * Фильтры работают поверх готового списка: записей у человека сотни, а не
 * миллионы, и держать ради них индекс — лишняя сущность, которая может
 * разойтись с файлами.
 */
export async function allMeetings(): Promise<Meeting[]> {
  const ids = await listMeetingIds()
  const out: Meeting[] = []
  for (const id of ids) {
    const meeting = await readMeeting(id)
    if (meeting) out.push(meeting)
  }
  out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  return out
}

export interface SearchHit {
  meeting: MeetingMeta
  snippets: string[]
}

export async function searchMeetings(query: string, limit = 10): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const ids = await listMeetingIds()
  const hits: SearchHit[] = []

  for (const id of ids) {
    if (hits.length >= limit) break
    const meeting = await readMeeting(id)
    if (!meeting) continue

    const snippets: string[] = []
    if (meeting.title.toLowerCase().includes(needle)) snippets.push(meeting.title)
    if (meeting.summary?.tldr.toLowerCase().includes(needle)) snippets.push(meeting.summary.tldr)
    for (const utterance of meeting.utterances) {
      if (snippets.length >= 3) break
      if (utterance.text.toLowerCase().includes(needle)) snippets.push(utterance.text)
    }
    if (snippets.length) {
      const { speakers, utterances, summary, ...meta } = meeting
      hits.push({ meeting: meta, snippets })
    }
  }
  return hits
}

export interface LiveLine {
  track: 'mic' | 'system'
  text: string
  start: number
  end: number
}

/**
 * Черновик идущего разговора.
 *
 * Пока запись не остановлена, полной расшифровки ещё нет — есть только куски,
 * которые приложение распознаёт на лету и дописывает в файл. Агенту этого
 * достаточно, чтобы отвечать на «о чём сейчас говорят».
 */
export async function readLive(id: string): Promise<LiveLine[]> {
  const file = path.join(meetingsDir(), id, 'live.jsonl')
  if (!existsSync(file)) return []
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LiveLine)
      .sort((a, b) => a.start - b.start)
  } catch {
    return []
  }
}

/** Идёт ли запись прямо сейчас: у неё нет времени окончания. */
export async function activeMeeting(): Promise<MeetingMeta | null> {
  for (const id of (await listMeetingIds()).slice(0, 5)) {
    const meta = await readMeta(id)
    if (meta && !meta.endedAt && meta.stages.recording === 'running') return meta
  }
  return null
}

/**
 * Запись изменений обратно в хранилище.
 *
 * Агенту разрешено немного: дописать задачу, отметить её сделанной, поправить
 * конспект, повесить тег. Ни звук, ни реплики он трогать не может — расшифровка
 * это протокол разговора, и переписывать сказанное задним числом нельзя.
 */
export async function updateMeeting(
  id: string,
  change: (meeting: Meeting) => Meeting
): Promise<Meeting> {
  const meeting = await readMeeting(id)
  if (!meeting) throw new Error(`запись не найдена: ${id}`)
  const next = Meeting.parse(change(meeting))

  const { speakers, utterances, summary, ...meta } = next
  const dir = path.join(meetingsDir(), id)
  await writeFile(path.join(dir, 'transcript.json'), JSON.stringify({ speakers, utterances, summary }, null, 2))
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  if (summary) {
    await writeFile(path.join(dir, 'summary.md'), renderSummaryMarkdown(next))
  }
  return next
}

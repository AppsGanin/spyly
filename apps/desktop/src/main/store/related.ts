import { statSync } from 'node:fs'
import { meetingTerms, relatedMeetings, type Meeting, type Related } from '@spyly/core'
import { listMeetings, readMeeting } from './meetings.js'
import { meetingFile } from './paths.js'

/**
 * Поиск похожих записей с запоминанием разобранных слов.
 *
 * Наивно это стоит дорого: страница записи открывается часто, а чтобы найти
 * похожие, надо прочитать расшифровки всех соседей. За месяц работы архив
 * вырастает до сотен мегабайт, и окно замирало бы на каждом открытии.
 *
 * Слова записи меняются только вместе с файлом расшифровки, поэтому храним их
 * с отметкой времени файла и перечитываем только изменившиеся.
 */
interface Cached {
  mtimeMs: number
  meeting: Meeting
  /** Разобранные слова — самая дорогая часть сравнения. */
  terms: Map<string, string>
}

const cache = new Map<string, Cached>()

/** Сколько записей назад смотрим: дальше в прошлое связи почти всегда ложные. */
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

/** Запись удалили или изменили — забываем её. */
export function forgetRelated(id: string): void {
  cache.delete(id)
}

import type { Meeting, MeetingMeta } from './types.js'

/**
 * Поиск родственных записей.
 *
 * Один разговор редко живёт сам по себе: тема тянется через несколько встреч,
 * и, открыв запись, полезно сразу видеть, где об этом же говорили раньше.
 * Считаем близость по двум признакам — общие участники и общие редкие слова.
 */

/** Слова, которые есть в любом разговоре и потому ничего не различают. */
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
 * Грубая основа слова — первые шесть букв.
 *
 * Настоящая лемматизация тянула бы за собой словарь на десятки мегабайт, а для
 * сравнения тем достаточно обрубка: «биллинг», «биллинга» и «биллингу» дают
 * одно и то же, а разные слова совпадают первыми шестью буквами редко.
 */
export function stem(word: string): string {
  return word.length > 6 ? word.slice(0, 6) : word
}

/**
 * Характерные слова записи: основа → как слово прозвучало.
 *
 * Пример нужен, чтобы показать человеку «совпало: биллинг, миграция», а не
 * обрубки вида «биллин».
 */
export function meetingTerms(meeting: Meeting, limit = 60): Map<string, string> {
  const counts = new Map<string, number>()
  const examples = new Map<string, string>()
  for (const utterance of meeting.utterances) {
    for (const word of terms(utterance.text)) {
      const key = stem(word)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      // Показываем самую короткую форму: обычно она и есть словарная.
      const known = examples.get(key)
      if (!known || word.length < known.length) examples.set(key, word)
    }
  }

  // Слово, прозвучавшее один раз, чаще всего просто ослышка распознавателя.
  // Но на коротком разговоре не повторяется почти ничего, и отбрасывать
  // одиночные значило бы остаться вовсе без слов.
  let meaningful = [...counts.entries()].filter(([, count]) => count > 1)
  if (meaningful.length < 8) meaningful = [...counts.entries()]

  meaningful.sort((a, b) => b[1] - a[1])
  const out = new Map<string, string>()
  for (const [key] of meaningful.slice(0, limit)) out.set(key, examples.get(key) ?? key)
  return out
}

function names(meeting: Meeting): Set<string> {
  const out = new Set<string>()
  for (const speaker of meeting.speakers) {
    if (speaker.name) out.add(speaker.name.toLowerCase())
  }
  for (const name of meeting.calendarParticipants) out.add(name.toLowerCase())
  return out
}

function overlap(a: Iterable<string>, b: { has(key: string): boolean }, sizeA: number, sizeB: number): number {
  if (sizeA === 0 || sizeB === 0) return 0
  let shared = 0
  for (const value of a) if (b.has(value)) shared++
  return shared / Math.min(sizeA, sizeB)
}

export interface Related {
  meeting: MeetingMeta
  /** 0..1 — насколько записи похожи. */
  score: number
  /** Что именно совпало: показываем человеку, а не голое число. */
  sharedTerms: string[]
  sharedPeople: string[]
}

/**
 * Записи, похожие на эту.
 *
 * Порог намеренно высокий: ложная связь «это продолжение вчерашнего» хуже,
 * чем её отсутствие — она уводит не туда.
 */
export function relatedMeetings(
  meeting: Meeting,
  others: readonly Meeting[],
  options: {
    limit?: number
    minScore?: number
    /**
     * Откуда брать слова записи. Разбор расшифровки — самая дорогая часть, и
     * вызывающий обычно уже держит её в кэше.
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

    // Слова весят больше людей: одни и те же коллеги встречаются во всех
    // разговорах, а общая терминология — признак общей темы.
    const score =
      overlap(myTerms.keys(), theirTerms, myTerms.size, theirTerms.size) * 0.75 +
      overlap(myNames, theirNames, myNames.size, theirNames.size) * 0.25
    if (score < minScore || shared.length < 3) continue

    const { speakers, utterances, summary, ...meta } = other
    out.push({ meeting: meta, score, sharedTerms: shared.slice(0, 6), sharedPeople: people })
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

import type { Meeting, Utterance, Word } from './types.js'

/**
 * Правка расшифровки: разделить, объединить, вырезать.
 *
 * Разделение по голосам ошибается предсказуемо: на перебивках две фразы
 * слипаются в одну, а одна длинная разваливается надвое. Чинить это должен
 * человек, и чинить быстро — поэтому операции живут здесь, отдельно от
 * интерфейса, и покрыты тестами.
 */

/** Момент внутри реплики по позиции символа — пропорционально длине текста. */
function timeAt(utterance: Utterance, charIndex: number): number {
  const { start, end, text, words } = utterance

  // Если есть слова с таймкодами, берём начало первого слова, уходящего во
  // вторую половину: линейная прикидка по символам врёт тем сильнее, чем
  // длиннее реплика.
  if (words.length > 0) {
    let at = 0
    for (const word of words) {
      if (at >= charIndex) return word.start
      at += word.text.length + 1
    }
    return words[words.length - 1]!.end
  }

  const ratio = text.length > 0 ? Math.min(1, Math.max(0, charIndex / text.length)) : 0
  return start + (end - start) * ratio
}

/**
 * Свободный идентификатор на основе исходного.
 *
 * Простой суффикс не годится: разделив реплику дважды, мы получили бы два
 * одинаковых `u1b`, а дальше правка попадала бы не в ту реплику, и React
 * рисовал бы список с повторяющимися ключами.
 */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Разделение реплики в указанном месте.
 *
 * Возвращает null, если резать нечего: пустая половина хуже, чем отказ.
 * `taken` — идентификаторы, которые уже заняты в этой записи.
 */
export function splitUtterance(
  utterance: Utterance,
  charIndex: number,
  taken: ReadonlySet<string> = new Set()
): [Utterance, Utterance] | null {
  const head = utterance.text.slice(0, charIndex).trim()
  const tail = utterance.text.slice(charIndex).trim()
  if (!head || !tail) return null

  const at = Math.min(Math.max(timeAt(utterance, charIndex), utterance.start), utterance.end)
  const headWords: Word[] = utterance.words.filter((w) => w.start < at)
  const tailWords: Word[] = utterance.words.filter((w) => w.start >= at)

  return [
    { ...utterance, text: head, end: at, words: headWords },
    { ...utterance, id: uniqueId(`${utterance.id}b`, taken), text: tail, start: at, words: tailWords }
  ]
}

/**
 * Склейка двух соседних реплик.
 *
 * Говорящий берётся у первой: объединяют обычно потому, что вторая половина
 * ошибочно приписана другому.
 */
export function mergeUtterances(first: Utterance, second: Utterance): Utterance {
  return {
    ...first,
    text: `${first.text.trim()} ${second.text.trim()}`.trim(),
    start: Math.min(first.start, second.start),
    end: Math.max(first.end, second.end),
    words: [...first.words, ...second.words].sort((a, b) => a.start - b.start)
  }
}

/**
 * Реплики, попавшие в вырезаемый промежуток.
 *
 * Задевшие край удаляются целиком: обрезать фразу по секундам — значит
 * оставить в расшифровке половину слова.
 */
export function utterancesInRange(meeting: Meeting, from: number, to: number): Utterance[] {
  const [a, b] = from <= to ? [from, to] : [to, from]
  return meeting.utterances.filter((u) => u.start < b && u.end > a)
}

/**
 * Порог сомнения для конкретной записи.
 *
 * Абсолютное число здесь не работает: на чистой записи модель уверена почти
 * везде, на шумной — нигде, и фиксированный порог либо не подчеркнёт ничего,
 * либо подчеркнёт весь текст. Берём нижние проценты этой записи — подсветка
 * всегда указывает на худшее из того, что есть, и остаётся редкой.
 */
export function doubtThreshold(meeting: Pick<Meeting, 'utterances'>): number {
  const values: number[] = []
  for (const utterance of meeting.utterances) {
    for (const word of utterance.words) {
      if (typeof word.confidence === 'number') values.push(word.confidence)
    }
  }
  if (values.length < 20) return 0.6

  values.sort((a, b) => a - b)
  const at = values[Math.floor(values.length * 0.05)] ?? 0.6
  // Ниже 0.5 сомнение и так очевидно, выше 0.9 подчёркивать бессмысленно:
  // там модель уверена, и ошибки другого рода.
  return Math.min(0.9, Math.max(0.5, at))
}

/** Слова, в которых модель сомневалась. */
export function doubtfulWords(utterance: Utterance, threshold = 0.6): Set<number> {
  const out = new Set<number>()
  utterance.words.forEach((word, index) => {
    if (typeof word.confidence === 'number' && word.confidence < threshold) out.add(index)
  })
  return out
}

/**
 * Насколько модель была уверена в реплике целиком.
 *
 * Нужна, чтобы показать список сомнительных мест, не перебирая слова в
 * интерфейсе. Возвращает null, когда уверенности нет вовсе — у черновиков
 * live-режима и у правленого руками текста.
 */
export function utteranceConfidence(utterance: Utterance): number | null {
  const values = utterance.words.map((w) => w.confidence).filter((v): v is number => typeof v === 'number')
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

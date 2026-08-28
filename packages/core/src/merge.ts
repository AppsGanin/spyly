import type { AsrResult, AsrSegment, Meeting, SpeakerTurn, TrackId, Utterance, Word } from './types.js'

/** Длительность пересечения двух отрезков. Ноль, если не пересекаются. */
export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/** Пауза, после которой реплика одного и того же человека разрывается на две. */
/**
 * Длина, после которой реплику пора разбить.
 *
 * Разбиваем не по счётчику, а по ближайшему концу предложения после него:
 * рвать на полуслове хуже, чем показать реплику чуть длиннее.
 */
const UTTERANCE_MAX_SEC = 35

const UTTERANCE_GAP_SEC = 1.5

/**
 * Кластер, которому принадлежит отрезок: тот, с кем пересечение максимально.
 * Если пересечений нет вовсе (слово попало в паузу диаризации) — берём
 * ближайший по времени отрезок, иначе слово потерялось бы.
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

/** Слова сегмента; если ASR не дал пословных таймкодов — сам сегмент как одно «слово». */
/**
 * Столько длится самое протяжное слово.
 *
 * Распознавание растягивает последние слова отрезка до его конца: на реальной
 * записи «перед» и «тем» получили по 3.5 секунды и перекрыли собой десять
 * секунд тишины. Из-за этого между словами не оставалось пауз, реплика
 * склеивалась через молчание и забирала себе чужое время в статистике.
 */
const MAX_WORD_SEC = 2

function wordsOf(seg: AsrSegment): Word[] {
  const words =
    seg.words.length > 0 ? seg.words : [{ text: seg.text.trim(), start: seg.start, end: seg.end }]
  // Целую реплику одним «словом» не режем: там длительность осмысленна.
  if (words.length < 2) return words
  return words.map((w) =>
    w.end - w.start > MAX_WORD_SEC ? { ...w, end: w.start + MAX_WORD_SEC } : w
  )
}

/** Склейка текста с оглядкой на пунктуацию: перед точкой и запятой пробел не нужен. */
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
 * Разложить результат ASR одной дорожки по спикерам.
 *
 * Каждое слово получает кластер по максимальному пересечению с отрезками
 * диаризации, затем подряд идущие слова одного кластера собираются в реплику.
 * Реплика рвётся на смене кластера и на паузе длиннее UTTERANCE_GAP_SEC.
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
    // Нет диаризации — вся дорожка считается одним говорящим.
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
      // Один человек может говорить без пауз минутами, и тогда реплика
      // вырастает в стену текста, которую нельзя ни прочитать, ни
      // процитировать. Режем по концу предложения — но только когда реплика
      // уже длинная, чтобы не дробить обычный разговор на огрызки.
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
 * Слить дорожки в одну ленту. Кросс-трековое объединение спикеров не нужно:
 * человек физически не может быть одновременно в комнате и на том конце звонка.
 */
export function mergeTracks(...tracks: readonly Utterance[][]): Utterance[] {
  const all = tracks.flat()
  all.sort((a, b) => a.start - b.start || a.end - b.end || a.track.localeCompare(b.track))
  return all
}

/** Все идентификаторы спикеров, реально встречающиеся в репликах. */
export function usedSpeakerIds(utterances: readonly Utterance[]): string[] {
  const seen = new Set<string>()
  for (const u of utterances) seen.add(u.speakerId)
  return [...seen].sort()
}

/** Сколько говорил каждый — для сортировки списка участников и выбора «главного». */
export function speakingTime(utterances: readonly Utterance[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const u of utterances) {
    m.set(u.speakerId, (m.get(u.speakerId) ?? 0) + Math.max(0, u.end - u.start))
  }
  return m
}

/** Нормализация для сравнения текста: регистр, пунктуация и ё/е не важны. */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Доля общих слов — устойчивее посимвольного сравнения к оговоркам ASR. */
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

/** Доля слов `part`, встречающихся в `whole`. */
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
/** Насколько далеко от реплики микрофона ищем её источник в системной дорожке. */
export const ECHO_TIME_TOLERANCE_SEC = 2.5
/** Реплики короче этого не судим по словам: «да» и «ага» совпадут с чем угодно. */
export const ECHO_MIN_WORDS = 3
/** Насколько одновременно должна прозвучать короткая реплика, чтобы считаться эхом. */
export const SHORT_ECHO_WINDOW_SEC = 0.8
/** Столько начальных букв должно совпасть, чтобы счесть обрывок огрызком чужого слова. */
const ECHO_PREFIX_LEN = 4

/**
 * Похоже ли короткое слово на огрызок слова из чужой речи.
 *
 * Эхо динамиков распознаётся хуже оригинала, и от слова остаётся начало:
 * «займусь» превращается в «займь». Полное совпадение такое не поймает.
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
 * Убрать эхо динамиков из дорожки микрофона.
 *
 * Если человек сидит без наушников, микрофон слышит собеседника из колонок, и
 * та же фраза попадает в расшифровку дважды: один раз как удалённый участник,
 * второй — как кто-то «в комнате».
 *
 * Сравниваем не реплику с репликой, а реплику микрофона с текстом системной
 * дорожки за то же время: распознавание и разделение по голосам нарезают
 * дорожки по-разному, и пофразовое сравнение промахивается ровно там, где
 * границы не совпали.
 *
 * Собственную речь пользователя это не задевает: её нет в системной дорожке,
 * и совпадать ей не с чем. Совсем короткие реплики («да», «угу») не трогаем
 * вовсе — они случайно совпадают с чем угодно.
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

    // Совсем короткие реплики по словам не судим: «да» и «ага» случайно
    // совпадают с чем угодно. Исключение — когда фраза целиком повторяет
    // начало чужой почти в тот же момент: так выглядит эхо первого слова.
    if (words.length < minWords) {
      const echoed = nearby.some((system) => {
        const simultaneous = Math.abs(system.start - mic.start) <= SHORT_ECHO_WINDOW_SEC
        if (simultaneous && containment(mic.text, system.text) === 1) return true
        // Обрывок чужого слова поверх продолжающейся чужой речи.
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
  /** Доля от всего звучавшего времени, 0..1. */
  share: number
  utterances: number
}

/**
 * Кто сколько говорил.
 *
 * Считаем по репликам, а не по длительности записи: паузы и тишина не
 * принадлежат никому, и включать их в долю было бы неверно.
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
 * Собрать результат распознавания из уже готовой расшифровки.
 *
 * Нужно, когда обработку перезапускают не с самого начала: слова с временами
 * лежат в самих репликах, и по ним можно заново разложить речь по говорящим,
 * не расшифровывая звук второй раз. Без этого пересборка «с разделения по
 * голосам» собирала расшифровку из пустоты и стирала её.
 *
 * У реплик без разметки по словам берётся текст целиком: точность внутри
 * реплики теряется, но сама реплика остаётся на месте.
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
 * Свести двух участников в одного.
 *
 * Разделение по голосам иногда дробит речь одного человека на несколько
 * кластеров: часть сказана громче, часть поверх собеседника. Тогда он остаётся
 * в списке дважды, а его доля в разговоре делится пополам. Реплики исчезающего
 * переходят к остающемуся, порядок реплик не меняется.
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

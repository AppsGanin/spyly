import type { Utterance } from './types.js'

/**
 * Разделение «я» и «собеседник» по громкости дорожек.
 *
 * Всё разделение по голосам стоит на допущении: микрофон — это тот, кто сидит
 * за компьютером, системный звук — удалённые участники. Допущение рушится,
 * едва человек снимает наушники: динамики играют собеседника, микрофон его
 * записывает, и его реплики появляются в расшифровке дважды — вторым разом от
 * вашего имени.
 *
 * Сравнение текстов эту беду лечит плохо: распознавание двух дорожек расходится
 * настолько, что на реальной записи по тексту узнавалось лишь три эха из пяти.
 * Зато физика надёжна. Путь «динамики → микрофон» ослабляет звук в разы, и на
 * настоящей записи отношение громкостей держалось около 0.20 с разбросом в
 * сотые доли. Когда человек говорит сам, его микрофон громче того, что играет
 * в динамиках, — разница не в процентах, а в разы.
 */

/**
 * Во сколько раз микрофон должен быть громче системного звука, чтобы реплику
 * можно было считать своей.
 *
 * Порог с большим запасом: эхо давало 0.2, живая речь даёт заметно больше
 * единицы. Промежуток между ними широкий, и попасть в него случайно трудно.
 */
export const MIC_OVER_SYSTEM_RATIO = 0.6

/** Ниже этого уровня под словом нет речи — там тишина. */
export const SPEECH_RMS_THRESHOLD = 0.006

export interface LevelWindow {
  start: number
  end: number
  rms: number
}

/** Средняя громкость дорожки на отрезке. */
export function levelAt(windows: readonly LevelWindow[], start: number, end: number): number {
  let sum = 0
  let count = 0
  for (const w of windows) {
    if (w.end <= start || w.start >= end) continue
    sum += w.rms
    count++
  }
  return count > 0 ? sum / count : 0
}

/**
 * Слышал ли микрофон человека, а не динамики.
 *
 * Если системная дорожка в этот момент молчит, сравнивать не с чем — значит,
 * говорили в микрофон.
 */
export function micIsOwnVoice(micRms: number, systemRms: number): boolean {
  if (systemRms < 0.01) return true
  return micRms >= systemRms * MIC_OVER_SYSTEM_RATIO
}

/**
 * Слышит ли микрофон только динамики.
 *
 * Считаем по всей записи: если ни в один момент своей речи микрофон не
 * оказался громче системного звука, человек всё это время молчал, а дорожка
 * содержит одно эхо. Тогда её вклад в расшифровку — только вред.
 */
export function micIsOnlyEcho(
  micWindows: readonly LevelWindow[],
  systemWindows: readonly LevelWindow[]
): boolean {
  const speaking = micWindows.filter((w) => w.rms > 0.006)
  if (speaking.length === 0) return true

  const own = speaking.filter((w) => micIsOwnVoice(w.rms, levelAt(systemWindows, w.start, w.end)))
  // Единичные всплески бывают от стука по столу: нужна доля, а не факт.
  return own.length / speaking.length < 0.05
}

/**
 * Срезать чужой хвост в начале своей реплики.
 *
 * Куски двух дорожек нарезаются по-разному, и последнее слово собеседника
 * нередко попадает в начало вашей реплики: «…но тогда я, конечно, готов» —
 * и следом ваше «готов прикольно прикольно». Выбрасывать реплику целиком
 * нельзя, она ваша; надо снять ровно приклеившиеся слова.
 *
 * Слово снимаем, только если совпали оба признака: оно есть в конце соседней
 * чужой реплики и микрофон в этот момент был тише динамиков. Одного текста
 * мало — человек и правда может повторить чужое слово, и терять его обидно.
 */
export function trimEchoedStart(
  utterance: Utterance,
  previousRemote: { text: string; end: number } | null,
  levels: { mic: (from: number, to: number) => number; system: (from: number, to: number) => number },
  options: { maxWords?: number; gapSec?: number } = {}
): Utterance {
  const maxWords = options.maxWords ?? 3
  const gapSec = options.gapSec ?? 2

  if (!previousRemote || utterance.words.length === 0) return utterance
  if (utterance.start - previousRemote.end > gapSec) return utterance

  const normalize = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  // Хвост чужой реплики: приклеиться может только он.
  const tail = new Set(
    previousRemote.text
      .split(/\s+/)
      .slice(-5)
      .map(normalize)
      .filter(Boolean)
  )

  let drop = 0
  while (drop < Math.min(maxWords, utterance.words.length - 1)) {
    const word = utterance.words[drop]!
    if (!tail.has(normalize(word.text))) break

    // Второй признак — звук под словом. Либо микрофон в этот момент слышал
    // динамики, либо под словом вообще тишина: распознавание расставляет
    // времена приблизительно, и приклеившееся слово нередко оказывается там,
    // где человек молчал. Своё слово так выглядеть не может.
    const micLevel = levels.mic(word.start, word.end)
    const systemLevel = levels.system(word.start, word.end)
    const silent = micLevel < SPEECH_RMS_THRESHOLD
    if (!silent && micIsOwnVoice(micLevel, systemLevel)) break
    drop++
  }

  if (drop === 0) return utterance
  const words = utterance.words.slice(drop)
  return {
    ...utterance,
    words,
    start: words[0]!.start,
    text: words.map((w) => w.text).join(' ')
  }
}

/**
 * Оставить в реплике только то, что человек сказал сам.
 *
 * Реплика микрофона нередко склеивается из двух половин: сначала эхо
 * собеседника из динамиков, следом собственная речь. Судить о ней целиком по
 * средней громкости нельзя — на реальной записи такая реплика дала отношение
 * 0.52 и была отброшена вся, хотя вторая её половина звучала при полной тишине
 * в динамиках и принадлежала человеку.
 *
 * Поэтому решение принимается по каждому слову: остаются те, под которыми
 * микрофон громче динамиков. Возвращается `null`, если своей речи не осталось.
 */
export function keepOwnVoice(
  utterance: Utterance,
  levels: { mic: (from: number, to: number) => number; system: (from: number, to: number) => number }
): Utterance | null {
  if (utterance.words.length === 0) {
    return micIsOwnVoice(
      levels.mic(utterance.start, utterance.end),
      levels.system(utterance.start, utterance.end)
    )
      ? utterance
      : null
  }

  // Уровень динамиков смотрим с запасом по краям слова: между словами
  // собеседника есть короткие провалы, и по одному слову они выглядят как
  // тишина — тогда эхо проходит за собственную речь. Своя речь тянется
  // секундами, и запас ей не мешает.
  const around = 0.5
  const mine = utterance.words.filter((word) =>
    micIsOwnVoice(
      levels.mic(word.start, word.end),
      levels.system(word.start - around, word.end + around)
    )
  )
  if (mine.length === 0) return null
  if (mine.length === utterance.words.length) return utterance

  // Огрызок посреди чужой речи — шум распознавания, а не реплика: показывать
  // «да все нас» отдельной строкой хуже, чем не показывать вовсе. Смотрим и на
  // число слов, и на длительность: три слова за полсекунды — это не речь.
  const spoken = mine[mine.length - 1]!.end - mine[0]!.start
  if (mine.length < 3 || spoken < 1) return null

  return {
    ...utterance,
    text: mine.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim(),
    words: mine,
    start: mine[0]!.start,
    end: mine[mine.length - 1]!.end
  }
}

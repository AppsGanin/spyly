/**
 * Отсев выдумок распознавания.
 *
 * Whisper обучался в том числе на субтитрах, и на тишине выдаёт самую вероятную
 * строку из обучающих данных — титры вроде «Субтитры сделал DimaTorzok» или
 * «Thanks for watching». Ни порогом `no-speech`, ни подавлением неречевых
 * токенов это не лечится: проверено на whisper.cpp large-v3, фраза пролезает
 * при любых значениях.
 *
 * Список разделён на две части, и это важно. Подписи и имена ищутся подстрокой:
 * встретиться в живой речи они не могут. Концовки роликов вроде «спасибо за
 * просмотр» сверяются со всей строкой целиком — человек и правда может так
 * сказать, и вырезать такую реплику из середины разговора нельзя.
 */

/** Подписи и имена: ищутся подстрокой, ложных срабатываний не дают. */
const SIGNATURES: string[] = [
  // Русский: подписи авторов субтитров
  'dimatorzok',
  'dima torzok',
  'субтитры сделал',
  'субтитры создал',
  'субтитры создавал',
  'субтитры делал',
  'субтитры подготовил',
  'субтитры предоставил',
  'субтитры подогнал',
  'субтитры корректировал',
  'субтитры под редакцией',
  'редактор субтитров',
  'перевод и субтитры',
  'субтитры от amara',
  'алексей дубровский',

  // Английский
  'subtitles by',
  'amara.org',
  'transcription by',
  'subtitled by',
  'captions by',

  // Тот же баг на других языках — своё имя в каждом
  'altyazı',
  'titulky vytvořil',
  'johnyx',
  'ترجمة نانسي قنقر',
  '字幕by',
  'untertitel der amara.org-community',
  'sous-titres réalisés par',
  'subtítulos realizados por la comunidad de amara.org',
  'legendas pela comunidade amara.org'
]

/**
 * Концовки роликов: сверяются со всей строкой целиком.
 *
 * «Спасибо» или «to be continued» человек может сказать и всерьёз — вырезать
 * их из середины разговора нельзя, поэтому только полное совпадение.
 */
const CLOSINGS: string[] = [
  'продолжение следует',
  'спасибо за просмотр',
  'спасибо за внимание',
  'спасибо, что досмотрели до конца',
  'подписывайтесь на канал',
  'ставьте лайки и подписывайтесь',
  'не забудьте подписаться',
  'до новых встреч',
  'всем пока',

  'thank you',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'like and subscribe',
  'see you next time',
  'to be continued',
  'you',

  'gracias por ver el video',
  "merci d'avoir regardé cette vidéo",
  'vielen dank fürs zuschauen',
  'ご視聴ありがとうございました',
  '시청해 주셔서 감사합니다',
  '感谢观看',
  'kiitos',
  'kiitos kun katsoit'
]

/** То, что списком не выразить: имя с инициалом, пустая строка, служебные метки. */
const PATTERNS: RegExp[] = [
  // «Корректор А.Егорова» — само слово «корректор» в речи законно, поэтому
  // ловим только подпись целиком, с инициалом.
  /^корректор\s+[а-яё]\.?\s*[а-яё]*$/i,
  /^редактор\s+[а-яё]\.\s*[а-яё]*$/i,
  /^\[?\s*(music|applause|silence|blank[_\s]audio|музыка|аплодисменты)\s*\]?\.?$/i,
  /^[.．。…\s]*$/,
  /^(и|а|э|ы|the)\.?$/i
]

/** Строка без обрамляющей пунктуации и в нижнем регистре — для сверки со списками. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\s"«»'`(\[]+|[\s"«»'`)\].!?,;:…]+$/g, '')
    .trim()
}

/** Похожа ли реплика на выдумку модели, а не на реальную речь. */
export function isLikelyHallucination(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true

  const normalized = normalize(trimmed)
  if (!normalized) return true

  if (SIGNATURES.some((needle) => normalized.includes(needle))) return true
  if (CLOSINGS.includes(normalized)) return true
  if (PATTERNS.some((pattern) => pattern.test(trimmed))) return true

  return isRepetitionLoop(trimmed)
}

/**
 * Вырезать подпись субтитров, оставив живую речь.
 *
 * Подпись прилипает к началу или концу реплики, а вместе с ней уходил и весь
 * остальной текст: на реальной записи «Субтитры делал DimaTorzok» утащила за
 * собой тридцать семь секунд разговора. Ищем подпись до конца предложения и
 * убираем только её.
 *
 * Возвращается очищенный текст или `null`, если после вырезания не остаётся
 * ничего осмысленного — такую реплику показывать незачем.
 */
export function stripHallucination(text: string): string | null {
  let out = text.trim()
  if (!out) return null

  for (const needle of SIGNATURES) {
    for (;;) {
      const at = normalize(out).indexOf(needle)
      if (at === -1) break
      // Границы ищем по исходной строке: сравнение идёт по нормализованной,
      // но резать нужно то, что человек увидит.
      const span = matchSpan(out, needle)
      if (!span) break
      out = (out.slice(0, span.from) + ' ' + out.slice(span.to)).replace(/\s+/g, ' ').trim()
    }
  }

  if (!out) return null
  // Осталась пара слов — почти наверняка обрывок подписи, а не речь.
  if (out.split(/\s+/).length < 3) return null
  return out
}

/**
 * Границы подписи в исходной строке.
 *
 * Сравнение идёт по нормализованному тексту, а резать нужно исходный, поэтому
 * конец совпадения ищется наращиванием: берём кратчайший кусок, который после
 * нормализации совпадает с подписью целиком. Вырезаем ровно его — обрывать до
 * конца предложения нельзя, там уже живая речь.
 */
function matchSpan(text: string, needle: string): { from: number; to: number } | null {
  for (let from = 0; from < text.length; from++) {
    if (!normalize(text.slice(from, from + needle.length + 12)).startsWith(needle)) continue
    for (let to = from + 1; to <= Math.min(text.length, from + needle.length + 12); to++) {
      if (normalize(text.slice(from, to)) === needle) return { from, to }
    }
  }
  return null
}

/**
 * Зацикленный вывод модели.
 *
 * Whisper иногда сваливается в повтор одной фразы: «Я не знаю, что это значит.»
 * тридцать раз подряд там, где человек ничего подобного не говорил. На реальной
 * получасовой записи так получилось больше половины расшифровки.
 *
 * Ищем самую короткую повторяющуюся группу слов: если из неё состоит почти весь
 * текст, это залипание, а не речь. Люди повторяются, но не десять раз подряд
 * слово в слово.
 */
export function isRepetitionLoop(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  if (words.length < 6) return false
  if (new Set(words).size <= 2) return true

  // До 60% длины: фраза с оборванным повтором занимает чуть больше половины.
  for (let unit = 1; unit <= Math.min(12, Math.floor(words.length * 0.6)); unit++) {
    const head = words.slice(0, unit)
    const headText = head.join(' ')
    let repeats = 0
    let covered = 0
    for (let at = 0; at + unit <= words.length; at += unit) {
      if (words.slice(at, at + unit).join(' ') !== headText) break
      repeats++
      covered += unit
    }
    if (repeats < 1) continue

    // Хвост часто оборван на середине: модель останавливается посреди фразы.
    const tail = words.slice(covered)
    const tailIsStart = tail.length > 0 && tail.every((word, i) => word === head[i])
    if (tailIsStart) covered += tail.length

    const share = covered / words.length
    if (repeats >= 3 && share > 0.7) return true
    // Два полных повтора и оборванный третий — тоже залипание, но только для
    // длинных групп: «да, да» и «хорошо, хорошо» люди говорят и всерьёз.
    if (repeats === 2 && tailIsStart && unit >= 3 && share > 0.85) return true
    // Фраза и её оборванный повтор: «…что это значит. …что это».
    if (repeats === 1 && tailIsStart && unit >= 4 && tail.length >= 3 && share > 0.95) return true
  }
  return false
}

/** Порог энергии, ниже которого участок считается тишиной, а текст — выдумкой. */
export const SILENCE_RMS_THRESHOLD = 0.006

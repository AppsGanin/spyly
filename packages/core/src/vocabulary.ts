/**
 * Словарь терминов, который учится на правках.
 *
 * Если человек поправил в расшифровке «кубернетес» на «Kubernetes», то же слово
 * распознается неверно и в следующий раз. Вместо того чтобы заставлять его
 * отдельно ходить в настройки и вбивать термин руками, вытаскиваем кандидатов
 * прямо из правки.
 */

const WORD = /[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu

function words(text: string): string[] {
  return text.match(WORD) ?? []
}

/**
 * Слова, которые появились при правке и похожи на термин.
 *
 * Намеренно осторожно: лучше не предложить ничего, чем засорить словарь
 * обычными словами — словарь идёт в подсказку распознавателю и, разрастаясь,
 * начинает ему мешать.
 */
export function learnedTerms(before: string, after: string, known: readonly string[] = []): string[] {
  const had = new Set(words(before).map((w) => w.toLowerCase()))
  const seen = new Set(known.map((w) => w.trim().toLowerCase()))
  const out: string[] = []

  for (const word of words(after)) {
    const key = word.toLowerCase()
    if (had.has(key) || seen.has(key)) continue
    seen.add(key)

    // Термин — это либо слово с необычным написанием (заглавные внутри,
    // цифры, дефис, точка), либо латиница среди кириллицы, либо имя
    // с большой буквы. Обычное строчное русское слово термином не считаем.
    const hasInnerCaps = /\p{Lu}/u.test(word.slice(1))
    const hasDigitsOrPunct = /[\d._+-]/.test(word)
    const isLatin = /^[A-Za-z][A-Za-z\d._+-]*$/.test(word)
    const isCapitalized = /^\p{Lu}/u.test(word)

    if (word.length < 3) continue
    if (!(hasInnerCaps || hasDigitsOrPunct || isLatin || isCapitalized)) continue

    out.push(word)
  }
  return out
}

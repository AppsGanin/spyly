import { EN } from './i18n-en.js'

/**
 * Перевод интерфейса.
 *
 * Ключ перевода — сама русская строка. Так строки остаются читаемыми прямо в
 * коде, а не превращаются в `settings.audio.title`, по которому не понять, что
 * увидит человек. Незнакомая строка возвращается как есть: пропущенный перевод
 * показывает русский текст, а не пустоту и не имя ключа.
 *
 * Язык задаётся один раз при запуске и меняется перезагрузкой окна: он влияет
 * на каждую надпись, и перерисовывать половину приложения ради редкого действия
 * незачем.
 */

export type Lang = 'ru' | 'en'

let current: Lang = 'ru'

export function setLang(next: Lang): void {
  current = next
}

export function lang(): Lang {
  return current
}

/**
 * Перевести строку интерфейса.
 *
 * Подстановки передаются словарём и заменяются по имени: `t('Найдено {n}', {n: 3})`.
 * Так перевод не зависит от порядка слов — в английском он часто другой.
 */
export function t(ru: string, vars?: Record<string, string | number>): string {
  const text = current === 'ru' ? ru : (EN[ru] ?? ru)
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  )
}

/** Строки, для которых перевода нет, — чтобы их было чем находить. */
export function missingTranslations(strings: readonly string[]): string[] {
  return strings.filter((s) => !(s in EN))
}



import { EN } from './i18n-en.js'

/**
 * Translating the interface.
 *
 * The translation key is the Russian string itself. That keeps the strings
 * readable right there in the code instead of turning them into
 * `settings.audio.title`, which says nothing about what a person will see. An
 * unknown string comes back as it is: a missing translation shows the Russian
 * text rather than emptiness or the name of a key.
 *
 * The language is set once at startup and changed by reloading the window: it
 * affects every caption, and redrawing half the application for a rare action
 * is pointless.
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
 * Translate an interface string.
 *
 * Substitutions are passed as a dictionary and replaced by name:
 * `t('Найдено {n}', {n: 3})`. That way the translation does not depend on word
 * order, which English often has differently.
 */
export function t(ru: string, vars?: Record<string, string | number>): string {
  const text = current === 'ru' ? ru : (EN[ru] ?? ru)
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  )
}

/** Strings with no translation, so that there is a way to find them. */
export function missingTranslations(strings: readonly string[]): string[] {
  return strings.filter((s) => !(s in EN))
}



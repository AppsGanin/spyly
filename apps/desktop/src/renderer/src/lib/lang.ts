import { setLang, type Lang } from '@spyly/core'

/**
 * The interface language, before anything else.
 *
 * Some captions live in module-level constants, and those are computed on
 * import. So the language has to be set before any other module of the window
 * runs: this file is imported first, and only then everything else.
 *
 * Settings are read asynchronously and are not ready by this point, so the
 * language is duplicated in the window's local storage, which the settings
 * store keeps in step with the real setting.
 */
try {
  const saved = localStorage.getItem('spyly.lang')
  if (saved === 'ru' || saved === 'en') setLang(saved as Lang)
} catch {
  // Private mode: the default language will stay.
}

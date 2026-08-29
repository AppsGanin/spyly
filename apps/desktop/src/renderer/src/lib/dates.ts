import { lang, t } from '@spyly/core'

/** Dates are written in the language of the interface, not always in Russian. */
export function uiLocale(): string {
  return lang() === 'en' ? 'en-US' : 'ru-RU'
}

/** Grouping meetings by day, so the list reads without a date on every row. */
export function dayLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return t('Когда-то')

  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = startOf(new Date())
  const day = startOf(date)
  const diffDays = Math.round((today - day) / 86_400_000)

  if (diffDays === 0) return t('Сегодня')
  if (diffDays === 1) return t('Вчера')
  if (diffDays < 7) return t('На этой неделе')
  if (diffDays < 30) return t('В этом месяце')
  return date.toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' })
}

export function timeLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' })
}

export function fullDateLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(uiLocale(), {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  })
}


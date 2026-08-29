/**
 * Parsing deadlines that were spoken out loud.
 *
 * In a conversation a deadline sounds like "by the end of the week" or "on
 * Friday", not like a date. While it stays a string nothing can be done with
 * it: no sorting, no reminder. We parse it into a date, carefully, because an
 * invented deadline is worse than one that was never found.
 */

const DAY = 86_400_000

/** Weekdays as they are said in speech, the prepositional case included. */
const WEEKDAYS: [RegExp, number][] = [
  [/понедельник/i, 1],
  [/вторник/i, 2],
  [/сред[ауы]/i, 3],
  [/четверг/i, 4],
  [/пятниц[ауы]/i, 5],
  [/суббот[ауы]/i, 6],
  [/воскресень/i, 0]
]

const MONTHS: [RegExp, number][] = [
  [/январ/i, 0],
  [/феврал/i, 1],
  [/март/i, 2],
  [/апрел/i, 3],
  [/ма[йя]/i, 4],
  [/июн/i, 5],
  [/июл/i, 6],
  [/август/i, 7],
  [/сентябр/i, 8],
  [/октябр/i, 9],
  [/ноябр/i, 10],
  [/декабр/i, 11]
]

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function iso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The next such weekday, today not counted. */
function nextWeekday(from: Date, weekday: number): Date {
  const today = startOfDay(from)
  let delta = (weekday - today.getDay() + 7) % 7
  if (delta === 0) delta = 7
  return new Date(today.getTime() + delta * DAY)
}

/**
 * A deadline out of a phrase. Returns a date such as `2026-09-05`, or null if
 * there is no deadline.
 *
 * An unfamiliar expression gives null rather than "today": better to leave the
 * string as it is than to give a task an invented deadline.
 */
export function parseDue(input: string | undefined, now = new Date()): string | null {
  if (!input) return null
  const text = input.trim().toLowerCase()
  if (!text) return null

  const today = startOfDay(now)

  // A ready-made date is taken as it is.
  const isoMatch = /(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (isoMatch) return isoMatch[0]

  if (/послезавтра/.test(text)) return iso(new Date(today.getTime() + 2 * DAY))
  if (/завтра/.test(text)) return iso(new Date(today.getTime() + DAY))
  if (/сегодня|сейчас|срочно/.test(text)) return iso(today)

  // "By the end of the week" means Friday: the working week ends there rather
  // than on Sunday, and that is what is being promised in a conversation.
  if (/конц[еа]\s+недели/.test(text)) {
    const friday = nextWeekday(today, 5)
    return iso(today.getDay() === 5 ? today : friday)
  }
  if (/конц[еа]\s+месяца/.test(text)) {
    return iso(new Date(today.getFullYear(), today.getMonth() + 1, 0))
  }
  if (/следующ\w*\s+недел/.test(text)) return iso(nextWeekday(today, 1))

  // The spoken forms "5 September" and "by 5 September".
  const dayMonth = /(\d{1,2})\s*(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\w*/i.exec(text)
  if (dayMonth) {
    const day = Number(dayMonth[1])
    const month = MONTHS.find(([pattern]) => pattern.test(dayMonth[2] ?? ''))?.[1]
    if (month !== undefined && day >= 1 && day <= 31) {
      let date = new Date(today.getFullYear(), month, day)
      // The month named has already passed, so this is about next year.
      if (date.getTime() < today.getTime() - 180 * DAY) date = new Date(today.getFullYear() + 1, month, day)
      return iso(date)
    }
  }

  // The spoken forms "in 3 days" and "in a week".
  const inN = /через\s+(\d+)?\s*(день|дня|дней|недел\w*|месяц\w*)/i.exec(text)
  if (inN) {
    const amount = Number(inN[1] ?? 1) || 1
    const unit = inN[2] ?? ''
    if (/недел/.test(unit)) return iso(new Date(today.getTime() + amount * 7 * DAY))
    if (/месяц/.test(unit)) return iso(new Date(today.getFullYear(), today.getMonth() + amount, today.getDate()))
    return iso(new Date(today.getTime() + amount * DAY))
  }

  for (const [pattern, weekday] of WEEKDAYS) {
    if (pattern.test(text)) return iso(nextWeekday(today, weekday))
  }

  return null
}

/** How urgent a deadline is: for sorting and for colour in the task list. */
export function dueState(due: string | undefined, now = new Date()): 'none' | 'overdue' | 'today' | 'soon' | 'later' {
  if (!due) return 'none'
  const parsed = Date.parse(due)
  if (Number.isNaN(parsed)) return 'none'
  const today = startOfDay(now).getTime()
  const at = startOfDay(new Date(parsed)).getTime()
  if (at < today) return 'overdue'
  if (at === today) return 'today'
  if (at <= today + 3 * DAY) return 'soon'
  return 'later'
}

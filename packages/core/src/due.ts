/**
 * Разбор сроков, произнесённых голосом.
 *
 * В разговоре срок звучит как «до конца недели» или «в пятницу», а не датой.
 * Пока это строка, с ней ничего нельзя сделать: ни отсортировать, ни
 * напомнить. Разбираем в дату — осторожно, потому что придуманный срок хуже
 * ненайденного.
 */

const DAY = 86_400_000

/** Дни недели так, как их называют в речи, включая предложный падеж. */
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

/** Ближайший такой день недели, не считая сегодняшнего. */
function nextWeekday(from: Date, weekday: number): Date {
  const today = startOfDay(from)
  let delta = (weekday - today.getDay() + 7) % 7
  if (delta === 0) delta = 7
  return new Date(today.getTime() + delta * DAY)
}

/**
 * Срок из фразы. Возвращает дату вида `2026-09-05` или null, если срока нет.
 *
 * Незнакомое выражение — это null, а не «сегодня»: лучше оставить строку как
 * есть, чем поставить задаче выдуманный дедлайн.
 */
export function parseDue(input: string | undefined, now = new Date()): string | null {
  if (!input) return null
  const text = input.trim().toLowerCase()
  if (!text) return null

  const today = startOfDay(now)

  // Готовая дата — принимаем как есть.
  const isoMatch = /(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (isoMatch) return isoMatch[0]

  if (/послезавтра/.test(text)) return iso(new Date(today.getTime() + 2 * DAY))
  if (/завтра/.test(text)) return iso(new Date(today.getTime() + DAY))
  if (/сегодня|сейчас|срочно/.test(text)) return iso(today)

  // «до конца недели» — пятница: рабочая неделя заканчивается ей, а не
  // воскресеньем, и обещают в разговоре именно это.
  if (/конц[еа]\s+недели/.test(text)) {
    const friday = nextWeekday(today, 5)
    return iso(today.getDay() === 5 ? today : friday)
  }
  if (/конц[еа]\s+месяца/.test(text)) {
    return iso(new Date(today.getFullYear(), today.getMonth() + 1, 0))
  }
  if (/следующ\w*\s+недел/.test(text)) return iso(nextWeekday(today, 1))

  // «5 сентября», «до 5 сентября»
  const dayMonth = /(\d{1,2})\s*(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\w*/i.exec(text)
  if (dayMonth) {
    const day = Number(dayMonth[1])
    const month = MONTHS.find(([pattern]) => pattern.test(dayMonth[2] ?? ''))?.[1]
    if (month !== undefined && day >= 1 && day <= 31) {
      let date = new Date(today.getFullYear(), month, day)
      // Названный месяц уже прошёл — значит, речь про следующий год.
      if (date.getTime() < today.getTime() - 180 * DAY) date = new Date(today.getFullYear() + 1, month, day)
      return iso(date)
    }
  }

  // «через 3 дня», «через неделю»
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

/** Насколько срок горит: для сортировки и цвета в списке задач. */
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

import { lang, t } from './i18n.js'
import type { Meeting, Speaker, Utterance } from './types.js'

/** mm:ss or h:mm:ss, a monospaced timestamp for the transcript. */
export function timecode(seconds: number): string {
  // The duration from <audio> comes through as Infinity until the metadata has loaded.
  if (!Number.isFinite(seconds)) return '0:00'
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** "1 h 24 min", for cards and lists. */
export function humanDuration(seconds: number): string {
  const en = lang() === 'en'
  const sec = en ? 's' : 'сек'
  const min = en ? 'min' : 'мин'
  const hour = en ? 'h' : 'ч'

  if (!Number.isFinite(seconds)) return `0 ${sec}`
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} ${sec}`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} ${min}`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h} ${hour}` : `${h} ${hour} ${rem} ${min}`
}

/** The display name: the name given, "You" for the owner, otherwise the cluster number. */
export function speakerLabel(speaker: Speaker | undefined, fallbackId: string): string {
  if (!speaker) return fallbackId
  if (speaker.name) return speaker.name
  if (speaker.isMe) return t('Вы')
  const where = speaker.track === 'mic' ? t('В комнате') : t('Участник')
  return `${where} ${speaker.number ?? speaker.cluster + 1}`
}

function speakerMap(meeting: Meeting): Map<string, Speaker> {
  return new Map(meeting.speakers.map((s) => [s.id, s]))
}

export interface MarkdownOptions {
  /** Timestamps before utterances: an agent usually does not need them, a person does. */
  timecodes?: boolean
  includeSummary?: boolean
  includeHeader?: boolean
}

/** The transcript in markdown, read by people and coding agents alike. */
export function renderTranscriptMarkdown(meeting: Meeting, opts: MarkdownOptions = {}): string {
  const { timecodes = true, includeSummary = true, includeHeader = true } = opts
  const speakers = speakerMap(meeting)
  const lines: string[] = []

  if (includeHeader) {
    lines.push(`# ${meeting.title}`, '')
    const started = new Date(meeting.startedAt)
    const when = Number.isNaN(started.getTime()) ? meeting.startedAt : started.toLocaleString(lang() === 'en' ? 'en-US' : 'ru-RU')
    lines.push(`**Дата:** ${when}  `)
    lines.push(`**Длительность:** ${humanDuration(meeting.durationSec)}  `)
    const names = meeting.speakers.map((s) => speakerLabel(s, s.id))
    if (names.length) lines.push(`**Участники:** ${names.join(', ')}`)
    lines.push('')
  }

  if (includeSummary && meeting.summary) {
    const s = meeting.summary
    lines.push('## Кратко', '', s.tldr, '')
    if (s.keyPoints.length) {
      lines.push('## Основные тезисы', '')
      for (const p of s.keyPoints) lines.push(`- ${p}`)
      lines.push('')
    }
    if (s.decisions.length) {
      lines.push('## Решения', '')
      for (const d of s.decisions) lines.push(`- ${d}`)
      lines.push('')
    }
    if (s.actionItems.length) {
      lines.push('## Задачи', '')
      for (const a of s.actionItems) {
        const who = a.assignee ? ` — ${a.assignee}` : ''
        const due = a.due ? ` (до ${a.due})` : ''
        lines.push(`- [${a.done ? 'x' : ' '}] ${a.text}${who}${due}`)
      }
      lines.push('')
    }
    if (s.questions.length) {
      lines.push('## Открытые вопросы', '')
      for (const q of s.questions) lines.push(`- ${q}`)
      lines.push('')
    }
  }

  if (meeting.marks.length > 0) {
    lines.push('## Отмеченные места', '')
    for (const mark of [...meeting.marks].sort((a, b) => a.at - b.at)) {
      const context = mark.note || nearestUtterance(meeting.utterances, mark.at)?.text || ''
      lines.push(`- \`${timecode(mark.at)}\`${context ? ` — ${context}` : ''}`)
    }
    lines.push('')
  }

  lines.push('## Расшифровка', '')
  if (meeting.utterances.length === 0) {
    lines.push('_Речь не распознана._', '')
  }
  for (const u of meeting.utterances) {
    const who = speakerLabel(speakers.get(u.speakerId), u.speakerId)
    const tc = timecodes ? `\`${timecode(u.start)}\` ` : ''
    lines.push(`${tc}**${who}:** ${u.text}`, '')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** The summary alone, as a separate file. */
export function renderSummaryMarkdown(meeting: Meeting): string {
  if (!meeting.summary) return `# ${meeting.title}\n\n_Саммари ещё не сделано._\n`
  return renderTranscriptMarkdown(meeting, { includeSummary: true, timecodes: false })
    .split('## Расшифровка')[0]!
    .trimEnd() + '\n'
}

/** Plain text with no markup, for the clipboard and for pipes. */
export function renderPlainText(meeting: Meeting): string {
  const speakers = speakerMap(meeting)
  return meeting.utterances
    .map((u) => `[${timecode(u.start)}] ${speakerLabel(speakers.get(u.speakerId), u.speakerId)}: ${u.text}`)
    .join('\n') + '\n'
}

/**
 * The utterance nearest to a moment in time.
 *
 * A person places a mark as the conversation goes, usually a second or two
 * after the thing was said, so landing exactly inside an utterance's bounds is
 * not guaranteed.
 */
function nearestUtterance(utterances: readonly Utterance[], seconds: number): Utterance | undefined {
  let best: Utterance | undefined
  let bestDistance = Infinity
  for (const u of utterances) {
    const distance = seconds < u.start ? u.start - seconds : seconds > u.end ? seconds - u.end : 0
    if (distance < bestDistance) {
      best = u
      bestDistance = distance
    }
  }
  return best
}

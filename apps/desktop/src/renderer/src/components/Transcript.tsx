import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { t,
  accentFor,
  doubtThreshold,
  doubtfulWords,
  speakerLabel,
  timecode,
  type Mark,
  type Meeting,
  type Utterance
} from '@spyly/core'
import { IconMore, IconUsers } from '../lib/icons'
import { EmptyState, IconButton, Menu } from '../ui'

/** Who is speaking: a filter over the transcript, not over the audio. */
export type SpeakerFilter = 'all' | 'me' | 'others'

/** Highlighting a match: without it a hit is invisible in a long transcript. */
function highlight(text: string, needle: string, activeAt: number | null): ReactNode {
  if (!needle) return text
  const parts: ReactNode[] = []
  const lower = text.toLowerCase()
  const target = needle.toLowerCase()
  let from = 0
  for (;;) {
    const at = lower.indexOf(target, from)
    if (at === -1) break
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={`${at}-${parts.length}`} className={`hl ${activeAt === at ? 'hl--current' : ''}`}>
        {text.slice(at, at + target.length)}
      </mark>
    )
    from = at + target.length
  }
  parts.push(text.slice(from))
  return parts
}

/**
 * Text marked where the model was unsure.
 *
 * Editing the transcript is the most common manual work, and hunting by eye
 * for what was recognised wrongly takes longer than fixing it. Whisper returns
 * a confidence for every word, so underlining the doubtful ones costs nothing.
 */
function withDoubts(utterance: Utterance, threshold: number): ReactNode {
  const doubts = doubtfulWords(utterance, threshold)
  if (doubts.size === 0) return utterance.text

  // The text of an utterance is its words joined by spaces; if that has stopped
  // being true (after a manual edit, for instance), no highlighting is drawn, so
  // as not to underline the wrong places.
  const joined = utterance.words.map((w) => w.text).join(' ')
  if (joined !== utterance.text) return utterance.text

  return utterance.words.map((word, index) => (
    <span key={index} className={doubts.has(index) ? 'doubt' : undefined}>
      {word.text}
      {index < utterance.words.length - 1 ? ' ' : ''}
    </span>
  ))
}


export interface TranscriptActions {
  onSeek: (seconds: number) => void
  /**
   * Silencing a stretch of the recording.
   *
   * The only thing that still changes a transcript. Editing the text by hand
   * was removed: a record of what was said stops being one as soon as it can be
   * rewritten. This is not editing but redaction, and it takes the audio with it.
   */
  onRemoveRange: (utterance: Utterance) => void
}

export function Transcript({
  meeting,
  currentTime,
  follow = false,
  onFollowChange,
  query = '',
  matchIndex = 0,
  speakerFilter = 'all',
  marks = [],
  actions
}: {
  meeting: Meeting
  currentTime: number
  /** Follow the list along with playback. Switched off as soon as someone scrolls by hand. */
  follow?: boolean
  onFollowChange?: (follow: boolean) => void
  /** What is being searched for: matches are highlighted, but utterances are not hidden. */
  query?: string
  /** The index of the match to scroll to. */
  matchIndex?: number
  speakerFilter?: SpeakerFilter
  /** Marks placed during the recording. */
  marks?: Mark[]
  actions: TranscriptActions
}) {
  const activeRef = useRef<HTMLDivElement>(null)
  const matchRef = useRef<HTMLElement>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  // The threshold is measured over the whole recording rather than a single
  // utterance: otherwise everything in a quiet utterance gets underlined and
  // nothing in a loud one.
  const threshold = useMemo(() => doubtThreshold(meeting), [meeting.utterances])

  const speakers = useMemo(() => new Map(meeting.speakers.map((s) => [s.id, s])), [meeting.speakers])
  const accents = useMemo(() => {
    const map = new Map<string, string>()
    meeting.speakers.forEach((speaker, index) => map.set(speaker.id, accentFor(speaker.id, index)))
    return map
  }, [meeting.speakers])

  // The utterance being played; the list scrolls on its change, and only on that.
  const activeId = useMemo(
    () => meeting.utterances.find((u) => currentTime >= u.start && currentTime <= u.end)?.id ?? null,
    [meeting.utterances, currentTime]
  )

  // The list follows the audio, but only until a person starts scrolling
  // themselves: taking the scroll out of their hands is the worst thing such a
  // list can do.
  useEffect(() => {
    if (!follow || !activeId) return
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [follow, activeId])

  // Every mark belongs to exactly one utterance, the one it sits inside, or the
  // nearest one when it lands in a pause. Otherwise a single mark colours several
  // utterances at once and the point of "this bit matters" is lost.
  const markedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const mark of marks) {
      let best: { id: string; distance: number } | null = null
      for (const u of meeting.utterances) {
        const distance = mark.at < u.start ? u.start - mark.at : mark.at > u.end ? mark.at - u.end : 0
        if (!best || distance < best.distance) best = { id: u.id, distance }
        if (distance === 0) break
      }
      if (best && best.distance <= 5) ids.add(best.id)
    }
    return ids
  }, [marks, meeting.utterances])

  const needle = query.trim().toLowerCase()

  // Matches are numbered continuously across the whole transcript: "3 of 12"
  // only makes sense when counted from the start of the conversation.
  const matches = useMemo(() => {
    if (!needle) return []
    const out: { id: string; at: number }[] = []
    for (const utterance of meeting.utterances) {
      const lower = utterance.text.toLowerCase()
      let from = 0
      for (;;) {
        const at = lower.indexOf(needle, from)
        if (at === -1) break
        out.push({ id: utterance.id, at })
        from = at + needle.length
      }
    }
    return out
  }, [needle, meeting.utterances])

  const current = matches[matchIndex] ?? null

  // We scroll to the current match and seek the audio to it: searching a
  // recording is usually about listening to that spot again.
  useEffect(() => {
    if (!current) return
    matchRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [current?.id, current?.at])

  // Yours is the microphone track: it is your computer and your microphone.
  const shown = useMemo(() => {
    if (speakerFilter === 'all') return meeting.utterances
    return meeting.utterances.filter((u) =>
      speakerFilter === 'me' ? u.track === 'mic' : u.track !== 'mic'
    )
  }, [meeting.utterances, speakerFilter])

  if (meeting.utterances.length === 0) {
    return (
      <EmptyState
        icon={<IconUsers size={22} />}
        title={t('Расшифровки пока нет')}
        text={t('Расшифровка появится, когда обработка дойдёт до конца. Если она оборвалась, запустите её заново.')}
      />
    )
  }

  if (shown.length === 0) {
    return (
      <p className="dim" style={{ padding: 'var(--space-4) 0' }}>
        {speakerFilter === 'me' ? t('Здесь нет ваших реплик.') : t('Здесь нет реплик собеседников.')}
      </p>
    )
  }

  return (
    <div className="transcript" onWheel={() => onFollowChange?.(false)}>
      {shown.map((utterance, index) => {
        const speaker = speakers.get(utterance.speakerId)
        const previous = shown[index - 1]
        const sameSpeaker = previous?.speakerId === utterance.speakerId
        const active = currentTime >= utterance.start && currentTime <= utterance.end
        const accent = accents.get(utterance.speakerId) ?? 'blue'
        const marked = markedIds.has(utterance.id)
        const isCurrentMatch = current?.id === utterance.id
        // While a search is running the text is not editable: highlighting lives in
        // the markup, and an edit would mix it into the content.

        return (
          <div
            key={utterance.id}
            ref={active ? activeRef : undefined}
            data-utterance={utterance.id}
            className={`utterance ${active ? 'utterance--active' : ''} ${
              utterance.provisional ? 'utterance--provisional' : ''
            } ${marked ? 'utterance--marked' : ''} ${menuFor === utterance.id ? 'utterance--open' : ''}`}
          >
            <button
              className="utterance__time mono"
              onClick={() => actions.onSeek(utterance.start)}
              title={t('Слушать с этого места')}
            >
              {timecode(utterance.start)}
            </button>
            <div style={{ minWidth: 0 }}>
              {!sameSpeaker && (
                <div className="utterance__speaker">
                  <span className="speaker-dot" style={{ background: `var(--ds-${accent}-900)` }} />
                  <span style={{ color: `var(--ds-${accent}-900)` }}>
                    {speakerLabel(speaker, utterance.speakerId)}
                  </span>
                  {marked && <span className="badge badge--amber">{t('важное')}</span>}
                </div>
              )}
              <div
                ref={isCurrentMatch ? (matchRef as React.RefObject<HTMLDivElement>) : undefined}
                className="utterance__text"
              >
                {needle
                  ? highlight(utterance.text, query, isCurrentMatch ? current.at : null)
                  : withDoubts(utterance, threshold)}
              </div>
            </div>

            <div className="utterance__actions">
              <Menu
                trigger={
                  <IconButton
                    aria-label={t('Что сделать с репликой')}
                    title={t('Что сделать с репликой')}
                    onClick={() => setMenuFor(utterance.id)}
                  >
                    <IconMore />
                  </IconButton>
                }
                items={[
                  {
                    label: t('Вырезать этот фрагмент'),
                    onSelect: () => actions.onRemoveRange(utterance),
                    danger: true
                  }
                ]}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** How many times the query occurs in the transcript, for the counter above the list. */
export function countMatches(meeting: Meeting, query: string): number {
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  let count = 0
  for (const utterance of meeting.utterances) {
    const lower = utterance.text.toLowerCase()
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at === -1) break
      count++
      from = at + needle.length
    }
  }
  return count
}

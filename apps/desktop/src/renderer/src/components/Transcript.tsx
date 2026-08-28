import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { t,
  accentFor,
  doubtThreshold,
  doubtfulWords,
  speakerLabel,
  timecode,
  type Mark,
  type Meeting,
  type Speaker,
  type Utterance
} from '@spyly/core'
import { IconMore, IconUsers, IconVoiceMatch } from '../lib/icons'
import { EmptyState, IconButton, Menu } from '../ui'

/** Кто говорит: фильтр по расшифровке, а не по звуку. */
export type SpeakerFilter = 'all' | 'me' | 'others'

/** Подсветка найденного: без неё в длинной расшифровке совпадение не видно. */
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
 * Текст с отметками там, где модель сомневалась.
 *
 * Правка расшифровки — самая частая ручная работа, и глазами искать, что
 * именно распозналось неверно, дольше, чем исправить. Whisper отдаёт
 * уверенность по каждому слову, так что подчеркнуть сомнительное ничего не
 * стоит.
 */
function withDoubts(utterance: Utterance, threshold: number): ReactNode {
  const doubts = doubtfulWords(utterance, threshold)
  if (doubts.size === 0) return utterance.text

  // Текст реплики — это склейка её слов через пробел; если это перестало быть
  // так (например, после ручной правки), подсветку не рисуем, чтобы не
  // подчеркнуть не те места.
  const joined = utterance.words.map((w) => w.text).join(' ')
  if (joined !== utterance.text) return utterance.text

  return utterance.words.map((word, index) => (
    <span key={index} className={doubts.has(index) ? 'doubt' : undefined}>
      {word.text}
      {index < utterance.words.length - 1 ? ' ' : ''}
    </span>
  ))
}

/** Смещение курсора в символах от начала элемента — нужно для «разделить здесь». */
function caretOffset(root: HTMLElement): number | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return null
  const before = range.cloneRange()
  before.selectNodeContents(root)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().length
}

export interface TranscriptActions {
  onSeek: (seconds: number) => void
  onRenameSpeaker: (speaker: Speaker) => void
  onEditUtterance: (utteranceId: string, text: string) => void
  onSplit: (utteranceId: string, charIndex: number) => void
  onMergeNext: (utteranceId: string) => void
  onReassign: (utterance: Utterance) => void
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
  /** Вести список за воспроизведением. Выключается, как только листают руками. */
  follow?: boolean
  onFollowChange?: (follow: boolean) => void
  /** Что ищем: совпадения подсвечиваются, но реплики не прячутся. */
  query?: string
  /** Порядковый номер совпадения, к которому надо подъехать. */
  matchIndex?: number
  speakerFilter?: SpeakerFilter
  /** Отметки, поставленные во время записи. */
  marks?: Mark[]
  actions: TranscriptActions
}) {
  const activeRef = useRef<HTMLDivElement>(null)
  const matchRef = useRef<HTMLElement>(null)
  const caretRef = useRef<{ id: string; at: number } | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  // Порог считаем от записи целиком, а не от отдельной реплики: иначе в тихой
  // реплике подчеркнётся всё, а в громкой — ничего.
  const threshold = useMemo(() => doubtThreshold(meeting), [meeting.utterances])

  const speakers = useMemo(() => new Map(meeting.speakers.map((s) => [s.id, s])), [meeting.speakers])
  const accents = useMemo(() => {
    const map = new Map<string, string>()
    meeting.speakers.forEach((speaker, index) => map.set(speaker.id, accentFor(speaker.id, index)))
    return map
  }, [meeting.speakers])

  // Звучащая реплика; по её смене — и только по ней — список подъезжает.
  const activeId = useMemo(
    () => meeting.utterances.find((u) => currentTime >= u.start && currentTime <= u.end)?.id ?? null,
    [meeting.utterances, currentTime]
  )

  // Ведём список за звуком, но только пока человек сам не начал листать:
  // перехватывать прокрутку под руками — худшее, что может делать такой список.
  useEffect(() => {
    if (!follow || !activeId) return
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [follow, activeId])

  // Каждая отметка относится ровно к одной реплике — той, внутри которой она
  // стоит, а при попадании в паузу к ближайшей. Иначе одна отметка красит
  // сразу несколько реплик, и смысл «вот это важно» теряется.
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

  // Совпадения нумеруем сквозной нумерацией по всей расшифровке: «3 из 12»
  // имеет смысл только тогда, когда счёт идёт от начала разговора.
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

  // К текущему совпадению подъезжаем и перематываем звук: искать в записи
  // обычно нужно, чтобы это место переслушать.
  useEffect(() => {
    if (!current) return
    matchRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [current?.id, current?.at])

  // Никого не узнали по голосу — тогда «свои» это микрофонная дорожка: за
  // компьютером сидит тот, чей микрофон. Раньше здесь стоял `??`, но `isMe`
  // по умолчанию `false`, а не `undefined`, и запасной вариант не срабатывал:
  // фильтр «Только мои» показывал пустоту даже там, где человек говорил.
  const anyoneIsMe = useMemo(() => meeting.speakers.some((s) => s.isMe), [meeting.speakers])

  const shown = useMemo(() => {
    if (speakerFilter === 'all') return meeting.utterances
    return meeting.utterances.filter((u) => {
      const speaker = speakers.get(u.speakerId)
      const mine = anyoneIsMe ? (speaker?.isMe ?? false) : u.track === 'mic'
      return speakerFilter === 'me' ? mine : !mine
    })
  }, [meeting.utterances, speakerFilter, speakers, anyoneIsMe])

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
        // Пока идёт поиск, текст не редактируем: подсветка живёт разметкой,
        // и правка перемешала бы её с содержимым.
        const editable = !needle

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
                <button
                  className="utterance__speaker"
                  onClick={() => speaker && actions.onRenameSpeaker(speaker)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}
                  title={t('Назвать участника')}
                >
                  <span className="speaker-dot" style={{ background: `var(--ds-${accent}-900)` }} />
                  <span style={{ color: `var(--ds-${accent}-900)` }}>
                    {speakerLabel(speaker, utterance.speakerId)}
                  </span>
                  {marked && <span className="badge badge--amber">{t('важное')}</span>}
                  {/* Подпись «узнан по голосу» повторялась у каждой реплики и
                      забивала строку — оставили значок с подсказкой. */}
                  {speaker?.nameSource === 'voice-match' && (
                    <span className="voicemark" title={t('Имя подставлено по слепку голоса')} role="img" aria-label={t('узнан по голосу')}>
                      <IconVoiceMatch size={13} />
                    </span>
                  )}
                </button>
              )}
              <div
                ref={isCurrentMatch ? (matchRef as React.RefObject<HTMLDivElement>) : undefined}
                className="utterance__text"
                contentEditable={editable}
                suppressContentEditableWarning
                onKeyUp={(e) => {
                  const at = caretOffset(e.currentTarget)
                  if (at !== null) caretRef.current = { id: utterance.id, at }
                }}
                onMouseUp={(e) => {
                  const at = caretOffset(e.currentTarget)
                  if (at !== null) caretRef.current = { id: utterance.id, at }
                }}
                onBlur={(e) => {
                  const next = e.currentTarget.textContent ?? ''
                  if (next.trim() !== utterance.text.trim()) actions.onEditUtterance(utterance.id, next.trim())
                }}
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
                    label: t('Это говорил кто-то другой'),
                    onSelect: () => actions.onReassign(utterance),
                    disabled: meeting.speakers.length < 2,
                    hint: meeting.speakers.length < 2 ? t('В записи только один участник') : undefined
                  },
                  {
                    label: t('Разделить здесь'),
                    onSelect: () => {
                      const caret = caretRef.current
                      actions.onSplit(utterance.id, caret?.id === utterance.id ? caret.at : 0)
                    },
                    disabled: !editable,
                    hint: editable
                      ? t('Поставьте курсор в текст, где нужно разделить')
                      : t('Во время поиска реплики не правятся')
                  },
                  {
                    label: t('Склеить со следующей'),
                    onSelect: () => actions.onMergeNext(utterance.id),
                    disabled: index === shown.length - 1
                  },
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

/** Сколько раз запрос встречается в расшифровке — для счётчика над списком. */
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

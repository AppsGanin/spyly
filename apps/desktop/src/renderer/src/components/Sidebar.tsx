import { useEffect, useMemo, useRef, useState } from 'react'
import { t, humanDuration, timecode } from '@spyly/core'
import type { MeetingMeta } from '@spyly/core'
import { api } from '../lib/api'
import { dayLabel, timeLabel } from '../lib/dates'
import { IconRecord, IconSearch, IconSettings, IconStop } from '../lib/icons'
import { useStore } from '../lib/store'
import { Input, LevelMeter, Spinner } from '../ui'
import { StartDialog } from './StartDialog'

type Filter = 'all' | 'today' | 'week' | 'unprocessed'

const FILTERS: { id: Filter; label: string; title: string }[] = [
  { id: 'all', label: t('Все'), title: t('Все записи') },
  { id: 'today', label: t('Сегодня'), title: t('Записи за сегодня') },
  { id: 'week', label: t('Неделя'), title: t('Записи за последние семь дней') },
  { id: 'unprocessed', label: t('Без конспекта'), title: t('Записи, у которых ещё нет конспекта') }
]

const DAY = 86_400_000

function passes(meeting: MeetingMeta, filter: Filter): boolean {
  const at = Date.parse(meeting.startedAt)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

  if (filter === 'today') return at >= todayStart
  if (filter === 'week') return at >= todayStart - 6 * DAY
  if (filter === 'unprocessed') {
    // "Not processed" covers both a summary that was never made and a failed
    // transcription: from a person's point of view both mean "not ready yet".
    return meeting.stages.summarizing !== 'done' || meeting.stages.transcribing === 'failed'
  }
  return true
}

/**
 * The sidebar: recordings and navigation.
 *
 * The list and the navigation are separated visually, or "Tasks" and
 * "Settings" look like the same kind of row as a recording and the structure of
 * the screen reads wrongly.
 */
export function Sidebar() {
  const { meetings, view, setView, recording, progress, notify, levels } = useStore()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [results, setResults] = useState<{ meeting: MeetingMeta; snippet: string }[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const isRecording = recording.status === 'recording' || recording.status === 'paused'

  // The commands come from the shared shortcut layer: there is one for the whole window.
  useEffect(() => {
    const focusSearch = () => searchRef.current?.focus()
    const startRecording = () => setStartOpen(true)
    window.addEventListener('spyly:focus-search', focusSearch)
    window.addEventListener('spyly:start-recording', startRecording)
    return () => {
      window.removeEventListener('spyly:focus-search', focusSearch)
      window.removeEventListener('spyly:start-recording', startRecording)
    }
  }, [])

  /**
   * Search with a delay and a guard against a stale answer.
   *
   * The request used to go out on every keystroke, and search reads the
   * transcripts of every recording: on a thousand that is nearly half a second of
   * the main process, the very one taking in audio while recording. On top of
   * that the answers could arrive out of order, and the result for "b" covered
   * the result for "bio".
   */
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchToken = useRef(0)

  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current) }, [])

  const runSearch = (value: string): void => {
    setQuery(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const token = ++searchToken.current

    if (!value.trim()) {
      setResults(null)
      setSearching(false)
      return
    }

    setSearching(true)
    searchTimer.current = setTimeout(() => {
      void api
        .call('meetings:search', value)
        .then((found) => {
          // While we were waiting the person may have typed on: that answer is no longer needed.
          if (token !== searchToken.current) return
          setResults(found)
          setSearching(false)
        })
        .catch(() => {
          if (token === searchToken.current) setSearching(false)
        })
    }, 200)
  }

  const [tag, setTag] = useState<string | null>(null)

  // Only tags actually in use are shown: an empty list of filters is worse than none.
  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const meeting of meetings) {
      for (const t of meeting.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  }, [meetings])

  const visible = useMemo(
    () => meetings.filter((m) => passes(m, filter) && (!tag || m.tags.includes(tag))),
    [meetings, filter, tag]
  )

  const groups = useMemo(() => {
    const map = new Map<string, MeetingMeta[]>()
    for (const meeting of visible) {
      const label = dayLabel(meeting.startedAt)
      const list = map.get(label) ?? []
      list.push(meeting)
      map.set(label, list)
    }
    return [...map.entries()]
  }, [visible])

  return (
    <aside className="sidebar">
      <div className="sidebar__top">
        <div className="brand">
          <span className="brand__dot" />
          Spyly
        </div>

        {isRecording ? (
          <button className="sidebar__action sidebar__action--stop" onClick={() => void api.call('rec:stop')}>
            <IconStop />{t('Остановить запись')}</button>
        ) : (
          <button
            className="sidebar__action"
            title={t('Начать запись (⌘⇧R работает и когда окно спрятано)')}
            onClick={() => setStartOpen(true)}
            disabled={recording.status === 'starting'}
          >
            <IconRecord />
            {recording.status === 'starting' ? t('Начинаю…') : t('Начать запись')}
          </button>
        )}

        {/* Пока идёт запись, таймер виден с любого экрана: иначе про неё
            легко забыть, уйдя в настройки. */}
        {isRecording && (
          <button
            className="recpill"
            onClick={() => recording.meetingId && setView({ kind: 'meeting', id: recording.meetingId })}
            title={t('Открыть запись')}
          >
            {recording.status === 'recording' && <span className="recpill__dot" />}
            <span className="recpill__time mono">{timecode(recording.elapsedSec)}</span>
            <span className="grow dim">{recording.status === 'paused' ? t('на паузе') : t('идёт')}</span>
            <LevelMeter level={Math.max(levels.mic, levels.system)} bars={6} />
          </button>
        )}

        <div className="search">
          <span className="search__icon">{searching ? <Spinner /> : <IconSearch />}</span>
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => runSearch(e.target.value)}
            placeholder={t('Поиск  ⌘F')}
            aria-label={t('Поиск по расшифровкам')}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                runSearch('')
                e.currentTarget.blur()
              }
            }}
          />
        </div>

        {results === null && meetings.length > 3 && (
          <div className="filters" role="group" aria-label={t('Фильтр записей')}>
            {FILTERS.map((item) => (
              <button
                key={item.id}
                className={`filter ${filter === item.id ? 'filter--active' : ''}`}
                title={item.title}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
            {tags.map((name) => (
              <button
                key={name}
                className={`filter filter--tag ${tag === name ? 'filter--active' : ''}`}
                title={t('Записи с тегом «{name}»', { name: name })}
                onClick={() => setTag(tag === name ? null : name)}
              >
                #{name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar__list">
        {results !== null ? (
          results.length === 0 ? (
            <p className="dim sidebar__note">{t('Ничего не нашлось')}</p>
          ) : (
            results.map(({ meeting, snippet }) => (
              <button
                key={meeting.id}
                className={`item ${view.kind === 'meeting' && view.id === meeting.id ? 'item--active' : ''}`}
                onClick={() => setView({ kind: 'meeting', id: meeting.id })}
              >
                <span className="item__row">
                  <span className="item__dot" aria-hidden="true" />
                  <span className="item__title">{meeting.title}</span>
                </span>
                <span className="item__snippet">{snippet}</span>
              </button>
            ))
          )
        ) : meetings.length === 0 ? (
          <p className="dim sidebar__note">{t('Пока пусто. Нажмите «Начать запись», и расшифровка появится здесь.')}</p>
        ) : visible.length === 0 ? (
          <p className="dim sidebar__note">
            {t('По этому фильтру ничего нет.')}{' '}
            <button
              className="linklike"
              onClick={() => {
                setFilter('all')
                setTag(null)
              }}
            >{t('Показать все')}</button>
          </p>
        ) : (
          groups.map(([label, items]) => (
            <div key={label}>
              <div className="group__label">
                {label}
                <span className="group__count">{items.length}</span>
              </div>
              {items.map((meeting) => (
                <MeetingItem
                  key={meeting.id}
                  meeting={meeting}
                  active={view.kind === 'meeting' && view.id === meeting.id}
                  busy={progress[meeting.id]?.state === 'running'}
                  recordingNow={recording.meetingId === meeting.id && isRecording}
                  onClick={() => setView({ kind: 'meeting', id: meeting.id })}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <nav className="sidebar__nav" aria-label={t('Разделы')}>
        <button
          className={`navitem ${view.kind === 'settings' ? 'navitem--active' : ''}`}
          title={t('Настройки (⌘,)')}
          onClick={() => setView({ kind: 'settings' })}
        >
          <IconSettings />{t('Настройки')}</button>
      </nav>

      <StartDialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        onStarted={() => {
          setStartOpen(false)
          notify('success', t('Запись началась'))
        }}
      />
    </aside>
  )
}

function MeetingItem({
  meeting,
  active,
  busy,
  recordingNow,
  onClick
}: {
  meeting: MeetingMeta
  active: boolean
  busy: boolean
  recordingNow: boolean
  onClick: () => void
}) {
  // A summary is optional: without one a recording is not "broken", and there is no need to alarm.
  const broken = meeting.stages.transcribing === 'failed' || meeting.stages.diarizing === 'failed'
  const noSummary = !broken && meeting.stages.summarizing === 'failed'

  // The state is shown by a dot rather than a caption: in words it took a whole
  // line under every recording, and the list read twice as slowly.
  const state = recordingNow
    ? { modifier: 'item__dot--recording', label: t('идёт запись') }
    : busy
      ? { modifier: 'item__dot--busy', label: t('идёт обработка') }
      : broken
        ? { modifier: 'item__dot--broken', label: t('не расшифровалась') }
        : noSummary
          ? { modifier: 'item__dot--nosummary', label: t('без конспекта') }
          : null

  const details = [
    timeLabel(meeting.startedAt),
    meeting.durationSec > 0 ? humanDuration(meeting.durationSec) : null,
    meeting.marks.length > 0 ? t('отметок: {meeting_marks_length}', { meeting_marks_length: meeting.marks.length }) : null,
    state?.label
  ].filter(Boolean)

  return (
    <button
      className={`item ${active ? 'item--active' : ''}`}
      onClick={onClick}
      title={`${meeting.title} — ${details.join(', ')}`}
    >
      <span className="item__row">
        <span className={`item__dot ${state?.modifier ?? ''}`} aria-hidden="true" />
        <span className="item__title">{meeting.title}</span>
        <span className="item__when mono">{timeLabel(meeting.startedAt)}</span>
      </span>
      {/* Теги в списке: по ним запись узнаётся быстрее, чем по названию —
          особенно когда названия у половины разговоров похожи. */}
      {meeting.tags.length > 0 && (
        <span className="item__tags">
          {meeting.tags.map((tag) => (
            <span key={tag} className="badge badge--purple">
              {tag}
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

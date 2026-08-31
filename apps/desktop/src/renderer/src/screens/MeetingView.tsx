import { useCallback, useEffect, useRef, useState } from 'react'
import { t,
  accentFor,
  humanDuration,
  speakerLabel,
  speakingShares,
  timecode,
  type Meeting,
  type Utterance
} from '@spyly/core'
import { api, useAsync, useIpcEvent } from '../lib/api'
import { fullDateLabel, uiLocale } from '../lib/dates'
import { IconAlert, IconCheck, IconFlag, IconPause, IconPlay, IconRefresh, IconChevron, IconContinueRecord, IconSearch, IconStop, IconTag, IconTrash } from '../lib/icons'
import { useStore } from '../lib/store'
import { Button, IconButton, Input, LevelMeter, Menu, Modal, Spinner } from '../ui'
import { ExportBar } from '../components/ExportBar'
import { Player, type PlayerTrack } from '../components/Player'
import { SummaryPanel } from '../components/SummaryPanel'
import { Transcript, countMatches, type SpeakerFilter } from '../components/Transcript'
import { TranscriptSelection } from '../components/TranscriptSelection'


/** Model names: an identifier like `whisper-large-v3-turbo` reads badly. */
const MODEL_LABELS: Record<string, string> = {
  'whisper-large-v3-turbo': 'Whisper large-v3-turbo',
  'whisper-large-v3': 'Whisper large-v3',
  'parakeet-tdt-v3': 'Parakeet TDT v3',
  'nemotron-3.5': 'Nemotron Speech 3.5',
}

const STAGE_LABELS: Record<string, string> = {
  recording: t('Запись'),
  transcribing: t('Расшифровка'),
  summarizing: t('Конспект')
}

export function MeetingView({ id, initialTab }: { id: string; initialTab?: string }) {
  const { recording, progress, notify, setView, reloadMeetings, levels, live } = useStore()
  const [tab, setTab] = useState<'summary' | 'transcript' | 'live'>('summary')
  /**
   * A request to seek the player.
   *
   * This is an event rather than a position: it carries a number, because
   * clicking the same utterance a second time has to seek again. It used to be
   * just a number, so a repeat click did nothing at all, while the player,
   * remounting on return to the tab, rewound to the old spot and started playing.
   */
  const [seekTo, setSeekTo] = useState<{ at: number; n: number } | null>(null)
  const seek = useCallback((at: number) => setSeekTo((prev) => ({ at, n: (prev?.n ?? 0) + 1 })), [])
  const [inMeetingQuery, setInMeetingQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [speakerFilter, setSpeakerFilter] = useState<SpeakerFilter>('all')
  const [cutting, setCutting] = useState<Utterance | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  // Not following to begin with: on opening a recording the list should stay
  // where it is rather than scroll to the first utterance and hide the player.
  const [follow, setFollow] = useState(false)
  const isRecordingThis =
    recording.meetingId === id && (recording.status === 'recording' || recording.status === 'paused')
  // The draft is written up to the moment of stopping, so it is read again once
  // the recording has ended. Without this the "Draft" tab never appeared for the
  // whole time processing ran, which is exactly when it is needed: there is no
  // transcript yet.
  const { data: draftLines } = useAsync(() => api.call('meetings:live', id), [id, isRecordingThis])
  // While recording the draft comes from the live stream, afterwards from disk.
  // It used to be shown under "Transcript" during the recording and moved to a
  // tab of its own once it stopped: the same text under two different names,
  // depending on when you looked.
  const draft = isRecordingThis
    ? live.filter((u) => u.meetingId === id).map((u) => ({ track: u.track, text: u.text, start: u.start, end: u.end }))
    : (draftLines ?? [])

  // Instant text needs the streaming model. Without it speech is collected until
  // a pause and handed over in one lump, which arrives seconds late — and
  // nothing on this page said why.
  const { data: models } = useAsync(() => api.call('models:list'), [])
  const streamingReady = models?.some((m) => m.id === 'nemotron-3.5' && m.downloaded) ?? true
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [justAsked, setJustAsked] = useState(false)
  /** A retry was asked for, but the first pipeline event has not arrived yet. */
  const [retrying, setRetrying] = useState(false)
  const [tracks, setTracks] = useState<PlayerTrack[]>([])

  const { data: meeting, loading, error, reload } = useAsync(() => api.call('meetings:get', id), [id])
  // The summary button is shown only if there is something to build it with.
  const { data: providers } = useAsync(() => api.call('settings:providers'), [id])
  const canSummarize = (providers ?? []).some((p) => p.kind === 'llm' && p.ready)
  const stage = progress[id]



  // The summary really is being built: either the recording itself says so, or a
  // pipeline event does.
  const reallyRunning =
    meeting?.stages.summarizing === 'running' ||
    (stage?.stage === 'summarizing' && stage.state === 'running')

  // As soon as the pipeline confirms it has taken the work, the temporary flag
  // comes off: from there the state lives in the recording.
  useEffect(() => {
    if (reallyRunning) setJustAsked(false)
  }, [reallyRunning])

  // The pipeline has taken the work, so the temporary retry flag is no longer needed.
  const pipelineBusy = stage?.state === 'running'
  useEffect(() => {
    if (pipelineBusy) setRetrying(false)
  }, [pipelineBusy])

  useIpcEvent('meetings:changed', (payload) => {
    if (payload.id === id) reload()
  })

  useEffect(() => {
    void (async () => {
      // The outside path is not needed: the main process knows where a recording
      // lies and serves it over its own scheme.
      const [mic, system] = await Promise.all([
        api.call('meetings:audioPath', id, 'mic'),
        api.call('meetings:audioPath', id, 'system')
      ])
      const available: PlayerTrack[] = []
      if (mic && system) available.push('mix')
      if (mic) available.push('mic')
      if (system) available.push('system')
      setTracks(available)
    })()
  }, [id])

  // Up and down arrows move by utterance. Left and right seek by seconds and
  // live in the player; this is a step through the transcript, for when you need
  // to go back one phrase rather than five seconds.
  useEffect(() => {
    if (!meeting || meeting.utterances.length === 0) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()

      const list = meeting.utterances
      const index = list.findIndex((u) => currentTime < u.start - 0.05)
      // The current one is the last that started; we step from there.
      const here = index === -1 ? list.length - 1 : Math.max(0, index - 1)
      const next = event.key === 'ArrowDown' ? Math.min(list.length - 1, here + 1) : Math.max(0, here - 1)
      setFollow(true)
      seek(list[next]!.start)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [meeting, currentTime])

  // While recording, the draft is what is open: that is where the words appear.
  // Once processing is under way the transcript is shown, so it is visible how
  // it fills in.
  useEffect(() => {
    if (initialTab === 'transcript' || initialTab === 'summary') setTab(initialTab)
    else if (isRecordingThis) setTab('live')
    else if (meeting && !meeting.summary && meeting.utterances.length > 0) setTab('transcript')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting?.id, isRecordingThis])

  if (loading && !meeting) {
    return (
      <div className="empty">
        <Spinner />
      </div>
    )
  }

  if (!meeting) {
    return (
      <div className="empty">
        {/* Причина важна: «не найдена» и «не удалось прочитать» — разные беды,
            и во втором случае запись, скорее всего, цела. */}
        <p className="muted">{error ? t('Не удалось открыть запись: {error}', { error: error }) : t('Запись не найдена.')}</p>
        <Button onClick={() => setView({ kind: 'home' })}>{t('К списку записей')}</Button>
      </div>
    )
  }

  const regenerate = async () => {
    // The flag is needed exactly until the first pipeline event: after that the
    // state comes from the recording itself. It used to come off on a timer after a
    // second or so, and the button became active again while the summary was still
    // being built, so it could be started a second time.
    setJustAsked(true)
    try {
      await api.call('meetings:reprocess', id, 'summarizing')
    } catch (error) {
      setJustAsked(false)
      throw error
    }
  }

  const remove = async () => {
    await api.call('meetings:delete', id)
    setConfirmDelete(false)
    await reloadMeetings()
    setView({ kind: 'home' })
    notify('info', t('Запись удалена'))
  }

  // The match count is kept here: both the search field and the list need it.
  const matchCount = meeting ? countMatches(meeting, inMeetingQuery) : 0
  const step = (delta: number) => {
    if (matchCount === 0) return
    setMatchIndex((current) => (current + delta + matchCount) % matchCount)
  }

  // Two participants can be given the same name, so the header shows it once.
  const participants = [...new Set(meeting.speakers.map((s) => speakerLabel(s, s.id)))]

  // Plus a short "just pressed" flag: the first event does not arrive instantly.
  const summarizing = reallyRunning || justAsked

  const stages = ['recording', 'transcribing', 'summarizing'] as const
  const busy = stages.some((s) => meeting.stages[s] === 'running')
  // The stage panel takes up half the screen, so it is shown only while work is
  // under way or something substantial has broken. A summary that was never made
  // is explained right on the "Summary" tab.
  const broken = meeting.stages.transcribing === 'failed'
  const anyFailed = broken

  return (
    <>
      {/* Шапка в две строки: заголовок с действиями, под ними — сведения о
          записи во всю ширину. Иначе список участников делит строку с
          кнопками и обрезается там, где места ещё полно. */}
      <div className="main__header main__header--stacked">
        <div className="row" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <EditableTitle
              value={meeting.title}
              onChange={async (title) => {
                await api.call('meetings:update', id, { title })
                reload()
              }}
            />
          </div>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            {!isRecordingThis && <ContinueButton meeting={meeting} />}
            {!isRecordingThis && (
              <TagEditor
                tags={meeting.tags}
                onChange={async (tags) => {
                  await api.call('meetings:update', id, { tags })
                  reload()
                }}
              />
            )}
            {!isRecordingThis && (
              <ExportBar meetingId={id} ready={meeting.utterances.length > 0} />
            )}
            <IconButton onClick={() => setConfirmDelete(true)} aria-label={t('Удалить встречу')}>
              <IconTrash />
            </IconButton>
          </div>
        </div>

        <div className="item__meta item__meta--oneline">
          <span>{fullDateLabel(meeting.startedAt)}</span>
          {meeting.durationSec > 0 && (
            <>
              <span>·</span>
              <span>{humanDuration(meeting.durationSec)}</span>
            </>
          )}
          {participants.length > 0 && (
            <>
              <span>·</span>
              <span className="truncate" title={participants.join(', ')}>
                {participants.join(', ')}
              </span>
            </>
          )}
          {/* Чем расшифровано: через месяц по тексту не понять, лёгкой моделью
              его делали или самой точной. */}
          {meeting.providers.asr && (
            <>
              <span>·</span>
              <span title={t('Модель распознавания')}>{MODEL_LABELS[meeting.providers.asr] ?? meeting.providers.asr}</span>
            </>
          )}

          {meeting.tags.map((tag) => (
            <span key={tag} className="badge badge--purple">
              {tag}
            </span>
          ))}
        </div>

        {!isRecordingThis && <RelatedMeetings meetingId={id} />}
      </div>

      {isRecordingThis && <RecordingStrip levels={levels} error={recording.error} />}

      {(busy || anyFailed || meeting.utterances.length > 0) && !isRecordingThis && (
        <div style={{ padding: '0 var(--space-6) var(--space-4)' }}>
          <div className="card stages__card">
            <div className="stages">
              {stages.map((key) => {
                const state = meeting.stages[key] ?? 'pending'
                const isRunning = state === 'running'
                const detail = stage?.stage === key && stage.progress !== undefined ? ` · ${Math.round(stage.progress * 100)}%` : ''
                return (
                  <div key={key} className={`stage stage--${state}`}>
                    <span className="stage__mark">
                      {isRunning ? <Spinner /> : state === 'done' ? <IconCheck /> : state === 'failed' ? <IconAlert /> : '·'}
                    </span>
                    <span>
                      {STAGE_LABELS[key]}
                      {detail}
                      {state === 'skipped' && <span className="dim">{t('— пропущено')}</span>}
                      {state === 'failed' && meeting.errors[key] && (
                        <span className="dim"> — {meeting.errors[key]}</span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              {/* Пересобрать можно любой этап, а не только упавший: модель
                  сменилась, конспект не понравился, звук переслушали. */}
              <Menu
                align="start"
                trigger={
                  <Button size="sm" disabled={busy || retrying}>
                    <IconRefresh /> {busy || retrying ? t('Обрабатываю…') : t('Пересобрать')}
                  </Button>
                }
                items={[
                  { label: t('Всё заново, начиная с расшифровки'), stage: 'transcribing' as const },
                  { label: t('Только конспект'), stage: 'summarizing' as const }
                ].map((item) => ({
                  label: item.label,
                  onSelect: () => {
                    setRetrying(true)
                    void api.call('meetings:reprocess', id, item.stage)
                  }
                }))}
              />
            </div>

          </div>
        </div>
      )}

      <div className="tabs">
        <button className={`tab ${tab === 'summary' ? 'tab--active' : ''}`} onClick={() => setTab('summary')}>{t('Конспект')}</button>
        <button className={`tab ${tab === 'transcript' ? 'tab--active' : ''}`} onClick={() => setTab('transcript')}>
          {t('Расшифровка')}
          {meeting.utterances.length > 0 && <span className="dim"> {meeting.utterances.length}</span>}
        </button>
        {/* Черновик остаётся и после записи: по нему видно, что было на экране
            во время разговора. Точность у него ниже, зато он показывает
            происходившее так, как его видел человек. */}
        {(isRecordingThis || draft.length > 0) && (
          <button className={`tab ${tab === 'live' ? 'tab--active' : ''}`} onClick={() => setTab('live')}>
            {t('Черновик')}
          </button>
        )}
      </div>

      <div className="main__scroll" style={{ paddingTop: 'var(--space-5)' }}>
        {tab === 'live' ? (
          <LiveDraft lines={draft} live={isRecordingThis} streamingReady={streamingReady} />
        ) : tab === 'summary' ? (
          <SummaryPanel
            meeting={meeting}
            onGenerate={() => void regenerate()}
            onOpenSettings={() => setView({ kind: 'settings' })}
            generating={summarizing}
            canSummarize={canSummarize}
          />
        ) : isRecordingThis ? (
          <p className="dim" style={{ lineHeight: 'var(--leading-relaxed)', maxWidth: 640 }}>
            {t('Расшифровка соберётся после остановки записи. Пока идёт разговор, текст виден на вкладке «Черновик».')}
          </p>
        ) : (
          <div className="col" style={{ gap: 'var(--space-4)', maxWidth: 780 }}>
            {tracks.length > 0 && !isRecordingThis && (
              <Player
                meetingId={id}
                available={tracks}
                seekTo={seekTo}
                onTime={setCurrentTime}
                onPlayingChange={(playing) => playing && setFollow(true)}
              />
            )}
            {meeting.utterances.length > 8 && (
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <div className="search grow">
                  <span className="search__icon"><IconSearch /></span>
                  <Input
                    value={inMeetingQuery}
                    onChange={(e) => {
                      setInMeetingQuery(e.target.value)
                      setMatchIndex(0)
                    }}
                    placeholder={t('Найти в этой записи')}
                    aria-label={t('Поиск по этой записи')}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setInMeetingQuery('')
                        return
                      }
                      // Enter goes to the next match, Shift+Enter to the previous one: that is how
                      // search works everywhere.
                      if (e.key === 'Enter' && matchCount > 0) {
                        e.preventDefault()
                        step(e.shiftKey ? -1 : 1)
                      }
                    }}
                  />
                </div>
                {inMeetingQuery.trim() !== '' && (
                  <div className="finder">
                    <span className="finder__count mono">
                      {matchCount === 0 ? t('нет') : t('{at} из {total}', { at: matchIndex + 1, total: matchCount })}
                    </span>
                    <IconButton
                      aria-label={t('Предыдущее совпадение')}
                      title={t('Предыдущее (⇧↵)')}
                      disabled={matchCount === 0}
                      onClick={() => step(-1)}
                    >
                      <IconChevron style={{ transform: 'rotate(-90deg)' }} />
                    </IconButton>
                    <IconButton
                      aria-label={t('Следующее совпадение')}
                      title={t('Следующее (↵)')}
                      disabled={matchCount === 0}
                      onClick={() => step(1)}
                    >
                      <IconChevron style={{ transform: 'rotate(90deg)' }} />
                    </IconButton>
                  </div>
                )}
              </div>
            )}

            {/* Фильтр по говорящим показываем, только когда есть кого
                отфильтровывать: на монологе он бессмыслен. */}
            {meeting.speakers.length > 1 && (
              <div
                className="segmented"
                role="group"
                aria-label={t('Чьи реплики показывать')}
                style={{ alignSelf: 'flex-start' }}
              >
                {(
                  [
                    ['all', t('Все')],
                    ['me', t('Вы')],
                    ['others', t('Собеседники')]
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={`segmented__item ${speakerFilter === value ? 'segmented__item--active' : ''}`}
                    aria-pressed={speakerFilter === value}
                    onClick={() => setSpeakerFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            <TranscriptSelection meeting={meeting} />
            <SpeakingStats meeting={meeting} />
            <Transcript
              meeting={meeting}
              currentTime={currentTime}
              follow={follow}
              onFollowChange={setFollow}
              query={inMeetingQuery}
              matchIndex={matchIndex}
              speakerFilter={speakerFilter}
              marks={meeting.marks}
              actions={{
                onSeek: (seconds) => {
                  // A click on a timestamp is itself "follow again": the person has said where
                  // to look.
                  setFollow(true)
                  seek(seconds)
                },
                onRemoveRange: setCutting
              }}
            />
          </div>
        )}
      </div>

      <CutDialog meetingId={id} utterance={cutting} onClose={() => setCutting(null)} />

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('Удалить встречу?')}
        actions={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('Отмена')}</Button>
            <Button variant="danger" onClick={() => void remove()}>{t('Удалить')}</Button>
          </>
        }
      >
        <p className="muted">{t('Запись, расшифровка и конспект будут удалены с диска безвозвратно.')}</p>
      </Modal>
    </>
  )
}

/**
 * Who talked how much.
 *
 * A bar rather than numbers: the ratio reads instantly, while exact seconds
 * are rarely interesting and live in the tooltip.
 */
/**
 * Recording tags.
 *
 * There are deliberately no folders: one conversation often belongs to several
 * subjects at once, and filing it under a single folder would lose something.
 */
/**
 * An offer to remember a term after an edit to the transcript.
 *
 * Adding it silently will not do: stray words end up in edits too, and the
 * dictionary affects recognition of every recording that follows.
 */
/**
 * Reassign an utterance to another participant.
 *
 * Voice separation gets it wrong most often on interruptions, and a person has
 * to be the one to fix that, in a couple of clicks and without listening to the
 * whole recording again.
 */
/**
 * Conversations on the same subject.
 *
 * A subject almost never fits into one meeting: billing gets revisited three
 * times a month. The link is shown right here, so nobody has to search by hand.
 */
function RelatedMeetings({ meetingId }: { meetingId: string }) {
  const { setView } = useStore()
  const { data } = useAsync(() => api.call('meetings:related', meetingId), [meetingId])
  const related = data ?? []
  if (related.length === 0) return null

  return (
    <div className="related">
      <span className="dim">{t('Об этом же говорили:')}</span>
      {/* Разделитель — часть предыдущего элемента: иначе при переносе строка
          начинается с запятой. */}
      {related.map((item) => (
        <span key={item.meeting.id} className="related__item">
          <button
            className="linklike"
            onClick={() => setView({ kind: 'meeting', id: item.meeting.id })}
            title={[
              t('Совпали слова: {words}', { words: item.sharedTerms.join(', ') }),
              item.sharedPeople.length > 0 ? t('Общие участники: {people}', { people: item.sharedPeople.join(', ') }) : ''
            ]
              .filter(Boolean)
              .join('\n')}
          >
            {item.meeting.title}
          </button>
          {/* Названия у записей часто одинаковые — без даты их не различить. */}
          <span className="dim"> · {shortWhen(item.meeting.startedAt)}</span>
        </span>
      ))}
    </div>
  )
}

/** "Today at 14:05" for fresh recordings, a date for older ones. */
function shortWhen(iso: string): string {
  const at = new Date(iso)
  const today = new Date()
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  return sameDay
    ? at.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' })
}

/**
 * Append to this recording.
 *
 * A conversation often breaks off and resumes a couple of minutes later: the
 * connection dropped, they called back. The button lives on the recording's own
 * page rather than in the start dialog, because appending always goes to one
 * particular conversation, the one in front of you.
 */
/**
 * The draft transcript as it looked during the recording.
 *
 * The final one is more accurate, but the draft is a record of what happened:
 * it keeps what a person was reading during the conversation and reacting to.
 * Hence a tab of its own rather than replacing the main transcript.
 */
/**
 * The draft, as one running text.
 *
 * Timestamps and sides are deliberately absent. This is not the transcript but
 * a record of what was on screen while people talked; broken into stamped lines
 * it read as a worse copy of the transcript next to it, and the point of it —
 * seeing the words arrive — was lost in the furniture.
 */
function LiveDraft({
  lines,
  live = false,
  streamingReady = true
}: {
  lines: { track: 'mic' | 'system'; text: string; start: number; end: number }[]
  live?: boolean
  streamingReady?: boolean
}) {
  const bottom = useRef<HTMLDivElement>(null)
  const text = lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join(' ')

  // The tail is followed rather than the number of lines: a phrase is extended
  // in place, and its end slides past the bottom edge without the count changing.
  useEffect(() => {
    if (live) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [live, text])

  return (
    <div className="col" style={{ gap: 'var(--space-4)', maxWidth: 780 }}>
      <p className="field__hint">
        {live
          ? streamingReady
            ? t('Черновик, на лету. Точный текст соберётся после остановки записи.')
            : t('Потоковая модель не скачана, поэтому текст приходит кусками после пауз. С ней слова появляются почти сразу — скачать можно в настройках, в разделе «Расшифровка».')
          : t('Так расшифровка выглядела во время записи: черновая, на лету.')}
      </p>
      <div className="summary__tldr">
        {text || (live ? t('Пока тихо — текст появится, как только прозвучат первые слова.') : '')}
      </div>
      <div ref={bottom} />
    </div>
  )
}

function ContinueButton({ meeting }: { meeting: Meeting }) {
  const { recording, notify, reloadMeetings } = useStore()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const busyNow = recording.status !== 'idle'
  // Appending to a recording still being processed will not do: the pipeline is
  // rewriting its transcript right now.
  const processing = Object.values(meeting.stages).includes('running')
  const noSound = meeting.durationSec < 1

  const reason = busyNow
    ? t('Уже идёт запись')
    : processing
      ? t('Запись ещё обрабатывается')
      : noSound
        ? t('В этой записи нет звука')
        : null

  const start = async () => {
    setBusy(true)
    try {
      await api.call('rec:start', {
        mic: meeting.sources.mic,
        system: meeting.sources.system,
        continueMeetingId: meeting.id,
        title: meeting.title
      })
      await reloadMeetings()
      notify('success', t('Запись продолжена, новая часть добавится в конец'))
      setOpen(false)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('Не получилось продолжить'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <IconButton
        aria-label={t('Продолжить запись')}
        title={reason ?? t('Продолжить запись: новая часть допишется в конец')}
        disabled={reason !== null}
        onClick={() => setOpen(true)}
      >
        <IconContinueRecord />
      </IconButton>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('Продолжить запись')}
        actions={
          <>
            <Button onClick={() => setOpen(false)}>{t('Отмена')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void start()}>
              {busy ? t('Запускаю…') : t('Продолжить')}
            </Button>
          </>
        }
      >
        <p className="field__hint">
          {t('Новая часть допишется в конец «{title}» — получится один разговор длиной больше {length}. Источники звука те же, что были в первой части.', { title: meeting.title, length: humanDuration(meeting.durationSec) })}
        </p>
        <p className="field__hint">{t('Расшифровку и конспект после этого стоит собрать заново — они относятся только к первой части.')}</p>
      </Modal>
    </>
  )
}


/**
 * Cutting out a fragment.
 *
 * The audio is replaced with silence rather than shortened: a shift in duration
 * would break every timestamp and mark, while "nothing should be audible here"
 * is solved without that. The dialog says so plainly.
 */
function CutDialog({
  meetingId,
  utterance,
  onClose
}: {
  meetingId: string
  utterance: Utterance | null
  onClose: () => void
}) {
  const { notify } = useStore()
  const [busy, setBusy] = useState(false)

  const cut = async () => {
    if (!utterance) return
    setBusy(true)
    try {
      const { removed } = await api.call('meetings:removeRange', meetingId, utterance.start, utterance.end)
      notify('success', removed === 1 ? t('Фрагмент вырезан') : t('Вырезано реплик: {removed}', { removed: removed }))
      onClose()
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('Не получилось вырезать'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={utterance !== null}
      onClose={onClose}
      title={t('Вырезать фрагмент?')}
      actions={
        <>
          <Button onClick={onClose}>{t('Отмена')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void cut()}>
            {busy ? t('Вырезаю…') : t('Вырезать')}
          </Button>
        </>
      }
    >
      {utterance && (
        <>
          <p style={{ marginBottom: 'var(--space-3)' }}>
            «{utterance.text.slice(0, 200)}
            {utterance.text.length > 200 ? '…' : ''}»
          </p>
          <p className="field__hint">
            {t('Звук с {from} по {to} станет тишиной, реплика исчезнет из расшифровки. Длительность записи не изменится, остальные таймкоды останутся на своих местах. Вернуть вырезанное нельзя — и прошлые правки после этого тоже уже не отменить.', { from: timecode(utterance.start), to: timecode(utterance.end) })}
          </p>
        </>
      )}
    </Modal>
  )
}


function TagEditor({ tags, onChange }: { tags: string[]; onChange: (next: string[]) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const add = async () => {
    const value = draft.trim()
    if (!value || tags.some((t) => t.toLowerCase() === value.toLowerCase())) {
      setDraft('')
      return
    }
    setDraft('')
    await onChange([...tags, value])
  }

  return (
    <>
      <IconButton aria-label={t('Теги')} title={t('Теги')} onClick={() => setOpen(true)}>
        <IconTag />
      </IconButton>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('Теги записи')}
        actions={<Button onClick={() => setOpen(false)}>{t('Готово')}</Button>}
      >
        <p className="field__hint">{t('Теги собирают разговоры на одну тему. У записи их может быть несколько.')}</p>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('Например: биллинг')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
            }}
          />
          <Button onClick={() => void add()} disabled={!draft.trim()}>{t('Добавить')}</Button>
        </div>
        {tags.length > 0 && (
          <div className="chips">
            {tags.map((tag) => (
              <span key={tag} className="chip">
                {tag}
                <button
                  className="chip__remove"
                  aria-label={t('Убрать {tag}', { tag: tag })}
                  onClick={() => void onChange(tags.filter((t) => t !== tag))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </Modal>
    </>
  )
}

/**
 * How many people were in the conversation.
 *
 * Voice separation guesses this badly: on a half-hour recording of three people
 * it found fifty "participants". When the number is known it is set firmly, and
 * the answer becomes exact. We only offer this when the result is plainly
 * implausible: in the ordinary case an extra question is pointless.
 */

function SpeakingStats({ meeting }: { meeting: Meeting }) {
  const shares = speakingShares(meeting.utterances)
  if (shares.length < 2) return null

  const speakers = new Map(meeting.speakers.map((s) => [s.id, s]))
  const accents = new Map(meeting.speakers.map((s, i) => [s.id, accentFor(s.id, i)]))

  return (
    <div className="shares">
      <div className="shares__bar">
        {shares.map((share) => (
          <span
            key={share.speakerId}
            className="shares__part"
            style={{
              width: `${share.share * 100}%`,
              background: `var(--ds-${accents.get(share.speakerId) ?? 'blue'}-700)`
            }}
            title={`${speakerLabel(speakers.get(share.speakerId), share.speakerId)}: ${humanDuration(share.seconds)}`}
          />
        ))}
      </div>
      <div className="shares__legend">
        {shares.map((share) => (
          <span key={share.speakerId} className="shares__item">
            <span
              className="speaker-dot"
              style={{ background: `var(--ds-${accents.get(share.speakerId) ?? 'blue'}-700)` }}
            />
            {speakerLabel(speakers.get(share.speakerId), share.speakerId)}
            <span className="dim" title={t('{length} из времени, когда кто-то говорил', { length: humanDuration(share.seconds) })}>
              {Math.round(share.share * 100)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

function RecordingStrip({
  levels,
  error
}: {
  levels: { mic: number; system: number }
  /** Trouble with the audio source: shown right here, not only as a toast. */
  error: string | null
}) {
  const { recording, notify } = useStore()
  const paused = recording.status === 'paused'
  // The mark is placed instantly and the note typed afterwards: at the moment
  // something important is said there is no room for being distracted by typing.
  const [pending, setPending] = useState<{ id: string; at: number } | null>(null)
  const [note, setNote] = useState('')
  const noteRef = useRef<HTMLInputElement>(null)

  const addMark = async () => {
    const result = await api.call('rec:mark')
    if (!result) return
    setPending(result)
    setNote('')
    notify('success', t('Отмечено на {at}', { at: timecode(result.at) }))
    setTimeout(() => noteRef.current?.focus(), 0)
  }

  const saveNote = async () => {
    if (pending && note.trim()) await api.call('rec:markNote', pending.id, note.trim())
    setPending(null)
    setNote('')
  }

  // The "Mark" button also works from the keyboard: the event comes from the same place.
  useEffect(() => {
    const handler = () => void addMark()
    window.addEventListener('spyly:mark', handler)
    return () => window.removeEventListener('spyly:mark', handler)
  })

  return (
    <div style={{ padding: '0 var(--space-6) var(--space-4)' }}>
      <div className="recbar">
        {!paused && <span className="recbar__dot" />}
        <span className="recbar__time">{timecode(recording.elapsedSec)}</span>
        <span className="dim">{paused ? t('на паузе') : t('идёт запись')}</span>
        <div className="grow" />
        {recording.tracks.mic && (
          <span className="row" style={{ gap: 6 }}>
            <span className="dim" style={{ fontSize: 'var(--text-sm)' }}>{t('микрофон')}</span>
            <LevelMeter level={levels.mic} bars={8} />
          </span>
        )}
        {recording.tracks.system && (
          <span className="row" style={{ gap: 6 }}>
            <span className="dim" style={{ fontSize: 'var(--text-sm)' }}>{t('собеседники')}</span>
            <LevelMeter level={levels.system} bars={8} />
          </span>
        )}
        <Button size="sm" title={t('Отметить важное место (⌘M)')} onClick={() => void addMark()}>
          <IconFlag />{t('Отметить')}</Button>
        <Button size="sm" onClick={() => void api.call(paused ? 'rec:resume' : 'rec:pause')}>
          {paused ? <IconPlay /> : <IconPause />}
          {paused ? t('Продолжить') : t('Пауза')}
        </Button>
        <Button size="sm" variant="danger" onClick={() => void api.call('rec:stop')}>
          <IconStop />{t('Стоп')}</Button>
      </div>

      {/* Тост уезжает через несколько секунд, а беда с источником никуда не
          девается: пока она есть, ей место на глазах. */}
      {error && (
        <div className="recwarn" role="status">
          <IconAlert />
          <span>{error}</span>
        </div>
      )}

      {pending && (
        <div className="marknote">
          <span className="marknote__at mono">{timecode(pending.at)}</span>
          <Input
            ref={noteRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('Зачем отметили? Можно не писать')}
            aria-label={t('Пояснение к отметке')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveNote()
              if (e.key === 'Escape') setPending(null)
            }}
            onBlur={() => void saveNote()}
          />
          <Button size="sm" onClick={() => void saveNote()}>{t('Готово')}</Button>
        </div>
      )}
    </div>
  )
}

function EditableTitle({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <h1
      contentEditable
      suppressContentEditableWarning
      style={{ outline: 'none' }}
      onBlur={(e) => {
        const next = (e.currentTarget.textContent ?? '').trim()
        if (next && next !== value) onChange(next)
        else e.currentTarget.textContent = value
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
    >
      {value}
    </h1>
  )
}


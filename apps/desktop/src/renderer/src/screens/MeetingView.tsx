import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t,
  accentFor,
  humanDuration,
  speakerLabel,
  speakingShares,
  timecode,
  type Meeting,
  type Speaker,
  type Utterance
} from '@spyly/core'
import { api, useAsync, useIpcEvent } from '../lib/api'
import { useShortcuts } from '../lib/shortcuts'
import { fullDateLabel, uiLocale } from '../lib/dates'
import { IconAlert, IconCheck, IconFlag, IconPause, IconPlay, IconRefresh, IconChevron, IconContinueRecord, IconSearch, IconStop, IconTag, IconTrash } from '../lib/icons'
import { useStore } from '../lib/store'
import { Button, Field, IconButton, Input, LevelMeter, Menu, Modal, Spinner } from '../ui'
import { ExportBar } from '../components/ExportBar'
import { LiveTranscript } from '../components/LiveTranscript'
import { Player, type PlayerTrack } from '../components/Player'
import { SummaryPanel } from '../components/SummaryPanel'
import { Transcript, countMatches, type SpeakerFilter } from '../components/Transcript'
import { TranscriptSelection } from '../components/TranscriptSelection'


/** Имена моделей: идентификатор вроде `whisper-large-v3-turbo` читается плохо. */
const MODEL_LABELS: Record<string, string> = {
  'whisper-large-v3-turbo': 'Whisper large-v3-turbo',
  'whisper-large-v3': 'Whisper large-v3',
  'gigaam-v3-ru': 'GigaAM v3',
  'parakeet-tdt-v3': 'Parakeet TDT v3',
  'nemotron-3.5': 'Nemotron Speech 3.5',
  'whisper-medium': 'Whisper medium',
  'whisper-small': 'Whisper small'
}

const STAGE_LABELS: Record<string, string> = {
  recording: t('Запись'),
  transcribing: t('Расшифровка'),
  diarizing: t('Разделение по голосам'),
  identifying: t('Узнавание участников'),
  summarizing: t('Конспект')
}

export function MeetingView({ id, initialTab }: { id: string; initialTab?: string }) {
  const { recording, progress, notify, setView, reloadMeetings, levels, live } = useStore()
  const [tab, setTab] = useState<'summary' | 'transcript' | 'live'>('summary')
  /**
   * Просьба перемотать плеер.
   *
   * Это событие, а не позиция: у него есть номер, потому что клик по той же
   * самой реплике второй раз обязан снова перемотать. Раньше здесь лежало
   * просто число — повторный клик не срабатывал вовсе, а плеер, смонтировавшись
   * заново при возврате на вкладку, отматывал на старое место и включал звук.
   */
  const [seekTo, setSeekTo] = useState<{ at: number; n: number } | null>(null)
  const seek = useCallback((at: number) => setSeekTo((prev) => ({ at, n: (prev?.n ?? 0) + 1 })), [])
  const [inMeetingQuery, setInMeetingQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [speakerFilter, setSpeakerFilter] = useState<SpeakerFilter>('all')
  const [reassigning, setReassigning] = useState<Utterance | null>(null)
  const [cutting, setCutting] = useState<Utterance | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [renaming, setRenaming] = useState<Speaker | null>(null)
  const [learned, setLearned] = useState<string[]>([])
  // Изначально не ведём: при открытии записи список должен стоять на месте,
  // а не подъезжать к первой реплике, пряча плеер.
  const [follow, setFollow] = useState(false)
  const { data: voicesReady } = useAsync(() => api.call('voices:ready'), [id])
  const isRecordingThis =
    recording.meetingId === id && (recording.status === 'recording' || recording.status === 'paused')
  // Черновик дописывается до самой остановки, поэтому перечитываем его, когда
  // запись закончилась. Без этого вкладка «Черновик» не появлялась всё время,
  // пока идёт обработка, — а именно тогда она и нужна: расшифровки ещё нет.
  const { data: draftLines } = useAsync(() => api.call('meetings:live', id), [id, isRecordingThis])
  const draft = draftLines ?? []
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [justAsked, setJustAsked] = useState(false)
  /** Повтор запрошен, но первое событие конвейера ещё не пришло. */
  const [retrying, setRetrying] = useState(false)
  const [tracks, setTracks] = useState<PlayerTrack[]>([])

  const { data: meeting, loading, error, reload } = useAsync(() => api.call('meetings:get', id), [id])
  // Кнопку сборки конспекта показываем, только если есть чем собирать.
  const { data: providers } = useAsync(() => api.call('settings:providers'), [id])
  const canSummarize = (providers ?? []).some((p) => p.kind === 'llm' && p.ready)
  const stage = progress[id]

  /**
   * Отмена и возврат правок: ⌘Z и ⌘⇧Z.
   *
   * Слой горячих клавиш не срабатывает, пока фокус в поле ввода, поэтому
   * внутри редактируемого текста работает обычная отмена браузера — а эта
   * отменяет уже сохранённую правку целиком.
   */
  const undoStep = useCallback(
    async (direction: 'undo' | 'redo') => {
      const done = await api.call(direction === 'undo' ? 'edit:undo' : 'edit:redo', id)
      if (!done) {
        notify('info', direction === 'undo' ? t('Отменять нечего') : t('Возвращать нечего'))
        return
      }
      reload()
      void reloadMeetings()
      notify('success', `${direction === 'undo' ? t('Отменено') : t('Возвращено')}: ${done.label}`)
    },
    [id, notify, reload, reloadMeetings]
  )

  useShortcuts(
    useMemo(
      () => [
        { key: 'z', meta: true, run: () => void undoStep('undo') },
        { key: 'z', meta: true, shift: true, run: () => void undoStep('redo') }
      ],
      [undoStep]
    )
  )


  // Конспект действительно собирается: так говорит либо сама запись, либо
  // событие конвейера.
  const reallyRunning =
    meeting?.stages.summarizing === 'running' ||
    (stage?.stage === 'summarizing' && stage.state === 'running')

  // Как только конвейер подтвердил, что взялся, временный флаг снимаем:
  // дальше состояние живёт в записи.
  useEffect(() => {
    if (reallyRunning) setJustAsked(false)
  }, [reallyRunning])

  // Конвейер взялся за работу — временный флаг повтора больше не нужен.
  const pipelineBusy = stage?.state === 'running'
  useEffect(() => {
    if (pipelineBusy) setRetrying(false)
  }, [pipelineBusy])

  useIpcEvent('meetings:changed', (payload) => {
    if (payload.id === id) reload()
  })

  useEffect(() => {
    void (async () => {
      // Путь наружу не нужен: главный процесс сам знает, где лежит запись,
      // и отдаёт её по собственной схеме.
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

  // Стрелки вверх-вниз — по репликам. Влево-вправо перематывают на секунды и
  // живут в плеере; здесь именно шаг по расшифровке, когда нужно вернуться
  // «на одну фразу назад», а не на пять секунд.
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
      // Текущая — последняя начавшаяся; от неё и шагаем.
      const here = index === -1 ? list.length - 1 : Math.max(0, index - 1)
      const next = event.key === 'ArrowDown' ? Math.min(list.length - 1, here + 1) : Math.max(0, here - 1)
      setFollow(true)
      seek(list[next]!.start)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [meeting, currentTime])

  // Пока идёт обработка или запись, показываем расшифровку: там видно,
  // как она наполняется.
  useEffect(() => {
    if (initialTab === 'transcript' || initialTab === 'summary') setTab(initialTab)
    else if (isRecordingThis) setTab('transcript')
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

  const rename = async (name: string, remember: boolean) => {
    if (!renaming) return
    await api.call('meetings:renameSpeaker', id, renaming.id, name, remember)
    setRenaming(null)
    reload()
  }

  const regenerate = async () => {
    // Флаг нужен ровно до первого события от конвейера: дальше состояние
    // берётся из самой записи. Раньше он снимался по таймеру на секунду с
    // небольшим, и кнопка снова становилась активной, пока конспект ещё
    // собирался, — можно было запустить сборку второй раз.
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

  // Счёт совпадений держим здесь: он нужен и полю поиска, и списку.
  const matchCount = meeting ? countMatches(meeting, inMeetingQuery) : 0
  const step = (delta: number) => {
    if (matchCount === 0) return
    setMatchIndex((current) => (current + delta + matchCount) % matchCount)
  }

  // Двум участникам можно дать одно имя — в шапке показываем его один раз.
  const participants = [...new Set(meeting.speakers.map((s) => speakerLabel(s, s.id)))]

  // Плюс короткий флаг «только что нажали»: первое событие приходит не мгновенно.
  const summarizing = reallyRunning || justAsked

  const stages = ['recording', 'transcribing', 'diarizing', 'identifying', 'summarizing'] as const
  const busy = stages.some((s) => meeting.stages[s] === 'running')
  // Панель этапов занимает пол-экрана, поэтому показываем её только когда
  // работа идёт или сломалось что-то существенное. Несобранный конспект
  // объясняется прямо во вкладке «Конспект».
  const broken = meeting.stages.transcribing === 'failed' || meeting.stages.diarizing === 'failed'
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
          <div className="card" style={{ padding: 'var(--space-4) var(--space-5)' }}>
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
            <div className="row" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-2)' }}>
              {/* Пересобрать можно любой этап, а не только упавший: модель
                  сменилась, участников стало известно, конспект не понравился. */}
              <Menu
                align="start"
                trigger={
                  <Button size="sm" disabled={busy || retrying}>
                    <IconRefresh /> {busy || retrying ? t('Обрабатываю…') : t('Пересобрать')}
                  </Button>
                }
                items={[
                  { label: t('Всё заново, начиная с расшифровки'), stage: 'transcribing' as const },
                  { label: t('Разделение по голосам и дальше'), stage: 'diarizing' as const },
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
        {draft.length > 0 && (
          <button className={`tab ${tab === 'live' ? 'tab--active' : ''}`} onClick={() => setTab('live')}>{t('Черновик')}<span className="dim"> {draft.length}</span>
          </button>
        )}
      </div>

      <div className="main__scroll" style={{ paddingTop: 'var(--space-5)' }}>
        {tab === 'live' ? (
          <LiveDraft lines={draft} speakers={meeting.speakers} onSeek={seek} />
        ) : tab === 'summary' ? (
          <SummaryPanel
            meeting={meeting}
            onGenerate={() => void regenerate()}
            onOpenSettings={() => setView({ kind: 'settings' })}
            generating={summarizing}
            canSummarize={canSummarize}
          />
        ) : isRecordingThis ? (
          <LiveTranscript utterances={live.filter((u) => u.meetingId === id)} />
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
                      // Enter ведёт к следующему совпадению, Shift+Enter — к
                      // предыдущему: так работает поиск везде.
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
            <SpeakerCount meeting={meeting} onDone={reload} />
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
                  // Клик по таймкоду — это и есть «веди снова»: человек сам
                  // указал, куда смотреть.
                  setFollow(true)
                  seek(seconds)
                },
                onRenameSpeaker: setRenaming,
                onEditUtterance: async (utteranceId, text) => {
                  const { terms } = await api.call('meetings:editUtterance', id, utteranceId, text)
                  if (terms.length > 0) setLearned(terms)
                },
                onSplit: async (utteranceId, charIndex) => {
                  try {
                    await api.call('meetings:splitUtterance', id, utteranceId, charIndex)
                  } catch (error) {
                    notify('error', error instanceof Error ? error.message : t('Не получилось разделить'))
                  }
                },
                onMergeNext: async (utteranceId) => {
                  try {
                    await api.call('meetings:mergeUtterance', id, utteranceId)
                  } catch (error) {
                    notify('error', error instanceof Error ? error.message : t('Не получилось склеить'))
                  }
                },
                onReassign: setReassigning,
                onRemoveRange: setCutting
              }}
            />
          </div>
        )}
      </div>

      <LearnedTerms terms={learned} onClose={() => setLearned([])} />

      <ReassignDialog
        meetingId={id}
        utterance={reassigning}
        speakers={meeting.speakers}
        onClose={() => setReassigning(null)}
      />

      <CutDialog meetingId={id} utterance={cutting} onClose={() => setCutting(null)} />

      <SpeakerDialog
        speaker={renaming}
        meeting={meeting}
        canRemember={voicesReady?.ready ?? false}
        onClose={() => setRenaming(null)}
        onSave={(name, remember) => void rename(name, remember)}
      />

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
 * Кто сколько говорил.
 *
 * Полоса вместо цифр: соотношение читается мгновенно, а точные секунды
 * интересны редко и живут в подсказке.
 */
/**
 * Теги записи.
 *
 * Папок намеренно нет: один разговор часто относится сразу к нескольким темам,
 * и раскладывать его по одной папке пришлось бы с потерей.
 */
/**
 * Предложение запомнить термин после правки расшифровки.
 *
 * Молча добавлять нельзя: в правку попадают и случайные слова, а словарь
 * влияет на распознавание всех следующих записей.
 */
/**
 * Приписать реплику другому участнику.
 *
 * Разделение по голосам чаще всего ошибается на перебивках, и починить это
 * должен человек — за пару нажатий, не переслушивая запись целиком.
 */
/**
 * Разговоры на ту же тему.
 *
 * Тема почти никогда не умещается в одну встречу: к биллингу возвращаются
 * трижды за месяц. Показываем связь прямо здесь, чтобы не искать руками.
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

/** «Сегодня в 14:05» для свежих записей, дата — для старых. */
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
 * Дописать к этой записи.
 *
 * Разговор часто обрывается и продолжается через пару минут: связь упала,
 * перезвонили. Кнопка живёт на странице самой записи, а не в диалоге начала —
 * дописывают всегда к конкретному разговору, который перед глазами.
 */
/**
 * Черновая расшифровка, какой её было видно во время записи.
 *
 * Финальная точнее, но черновик — это протокол происходившего: в нём остаётся
 * то, что человек читал по ходу разговора и на что реагировал. Отсюда и
 * отдельная вкладка, а не подмена основной расшифровки.
 */
function LiveDraft({
  lines,
  speakers,
  onSeek
}: {
  lines: { track: 'mic' | 'system'; text: string; start: number; end: number }[]
  speakers: Speaker[]
  onSeek: (seconds: number) => void
}) {
  // Имена берём из финальной расшифровки, если она уже есть: «Вы» и
  // «Собеседник» точнее ничего, но имя лучше.
  const mine = speakers.find((s) => s.isMe)?.name
  const remote = speakers.find((s) => !s.isMe && s.name)?.name

  return (
    <div className="col" style={{ gap: 'var(--space-4)', maxWidth: 780 }}>
      <p className="field__hint">{t('Так расшифровка выглядела во время записи: она собиралась на лету и по частям, поэтому менее точна. Полный текст — на вкладке «Расшифровка».')}</p>

      <div className="transcript">
        {lines.map((line, index) => (
          <div key={index} className="utterance">
            <button
              className="utterance__time mono"
              onClick={() => onSeek(line.start)}
              title={t('Слушать с этого места')}
            >
              {timecode(line.start)}
            </button>
            <div style={{ minWidth: 0 }}>
              <div className="utterance__speaker">
                <span
                  className="speaker-dot"
                  style={{ background: `var(--ds-${line.track === 'mic' ? 'blue' : 'green'}-900)` }}
                />
                <span style={{ color: `var(--ds-${line.track === 'mic' ? 'blue' : 'green'}-900)` }}>
                  {line.track === 'mic' ? (mine ?? t('Вы')) : (remote ?? t('Собеседник'))}
                </span>
              </div>
              <div className="utterance__text">{line.text}</div>
            </div>
            <span />
          </div>
        ))}
      </div>
    </div>
  )
}

function ContinueButton({ meeting }: { meeting: Meeting }) {
  const { recording, notify, reloadMeetings } = useStore()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const busyNow = recording.status !== 'idle'
  // Дописывать в запись, которую ещё обрабатывают, нельзя: конвейер как раз
  // сейчас перезаписывает её расшифровку.
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

function ReassignDialog({
  meetingId,
  utterance,
  speakers,
  onClose
}: {
  meetingId: string
  utterance: Utterance | null
  speakers: Speaker[]
  onClose: () => void
}) {
  const { notify } = useStore()
  const [busy, setBusy] = useState(false)

  const assign = async (speakerId: string) => {
    if (!utterance) return
    setBusy(true)
    try {
      await api.call('meetings:reassignUtterance', meetingId, utterance.id, speakerId)
      onClose()
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('Не получилось. Попробуйте ещё раз'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={utterance !== null}
      onClose={onClose}
      title={t('Кто это сказал?')}
      actions={<Button onClick={onClose}>{t('Отмена')}</Button>}
    >
      {utterance && (
        <>
          <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
            «{utterance.text.slice(0, 120)}
            {utterance.text.length > 120 ? '…' : ''}»
          </p>
          <div className="picklist">
            {speakers.map((speaker, index) => (
              <button
                key={speaker.id}
                className={`picklist__item ${speaker.id === utterance.speakerId ? 'picklist__item--on' : ''}`}
                disabled={busy}
                onClick={() => void assign(speaker.id)}
              >
                <span
                  className="speaker-dot"
                  style={{ background: `var(--ds-${accentFor(speaker.id, index)}-900)` }}
                />
                <span className="grow">{speakerLabel(speaker, speaker.id)}</span>
                {speaker.id === utterance.speakerId && <span className="dim">{t('сейчас')}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

/**
 * Вырезание фрагмента.
 *
 * Звук заменяется тишиной, а не укорачивается: сдвиг длительности переломал бы
 * все таймкоды и отметки, а задача «здесь не должно быть слышно» решается и
 * так. Об этом честно написано прямо в диалоге.
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

function LearnedTerms({ terms, onClose }: { terms: string[]; onClose: () => void }) {
  const { notify } = useStore()
  const [picked, setPicked] = useState<string[]>([])

  useEffect(() => setPicked(terms), [terms])

  const save = async () => {
    if (picked.length > 0) {
      await api.call('vocab:add', picked)
      notify('success', picked.length === 1 ? t('«{term}» в словаре', { term: picked[0] ?? '' }) : t('Терминов в словаре: +{n}', { n: picked.length }))
    }
    onClose()
  }

  return (
    <Modal
      open={terms.length > 0}
      onClose={onClose}
      title={t('Запомнить термин?')}
      actions={
        <>
          <Button onClick={onClose}>{t('Отмена')}</Button>
          <Button variant="primary" onClick={() => void save()} disabled={picked.length === 0}>{t('Запомнить')}</Button>
        </>
      }
    >
      <p className="field__hint">{t('В следующих записях расшифровщик будет знать эти слова и реже их исказит.')}</p>
      <div className="chips">
        {terms.map((term) => {
          const on = picked.includes(term)
          return (
            <button
              key={term}
              className={`chip chip--toggle ${on ? 'chip--on' : ''}`}
              aria-pressed={on}
              onClick={() => setPicked(on ? picked.filter((t) => t !== term) : [...picked, term])}
            >
              {term}
            </button>
          )
        })}
      </div>
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
 * Сколько человек было в разговоре.
 *
 * Разделение по голосам угадывает это плохо: на получасовой записи троих
 * человек оно нашло полсотни «участников». Когда число известно, оно задаётся
 * жёстко — и ответ становится точным. Предлагаем только тогда, когда результат
 * явно неправдоподобен: в обычном случае лишний вопрос ни к чему.
 */
function SpeakerCount({ meeting, onDone }: { meeting: Meeting; onDone: () => void }) {
  const { notify } = useStore()
  const [busy, setBusy] = useState(false)
  const found = meeting.speakers.length

  // Больше шести голосов на обычном созвоне почти всегда означает ошибку
  // разделения, а не переговорную с восемью людьми.
  const suspicious = found > 6
  if (!suspicious && !meeting.speakerCount) return null

  const apply = async (count: number) => {
    setBusy(true)
    try {
      await api.call('meetings:update', meeting.id, { speakerCount: count })
      await api.call('meetings:reprocess', meeting.id, 'diarizing')
      notify('info', t('Пересобираю участников, это займёт около минуты'))
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ padding: 'var(--space-3) var(--space-4)' }}>
      <div className="spread" style={{ gap: 'var(--space-3)' }}>
        <div className="grow">
          <div style={{ fontWeight: 500 }}>
            {meeting.speakerCount
              ? t('Участников указано: {meeting_speakerCount}', { meeting_speakerCount: meeting.speakerCount })
              : t('Нашлось голосов: {found}', { found: found })}
          </div>
          <div className="field__hint">
            {meeting.speakerCount
              ? t('Можно поменять, разделение пересоберётся')
              : t('Похоже на ошибку разделения. Укажите, сколько человек говорило, и оно пересоберётся')}
          </div>
        </div>
        <div className="row" style={{ gap: 'var(--space-1)' }}>
          {[2, 3, 4, 5, 6].map((count) => (
            <button
              key={count}
              className={`segmented__item ${meeting.speakerCount === count ? 'segmented__item--active' : ''}`}
              disabled={busy}
              onClick={() => void apply(count)}
            >
              {count}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

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
  /** Беда с источником звука: показываем прямо здесь, а не только тостом. */
  error: string | null
}) {
  const { recording, notify } = useStore()
  const paused = recording.status === 'paused'
  // Отметка ставится мгновенно, а пояснение печатается после: в момент, когда
  // прозвучало важное, отвлекаться на набор текста нельзя.
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

  // Кнопка «Отметить» доступна и с клавиатуры: событие приходит оттуда же.
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

function SpeakerDialog({
  speaker,
  meeting,
  canRemember,
  onClose,
  onSave
}: {
  speaker: Speaker | null
  meeting: Meeting
  /** Есть ли модель слепков: без неё запоминать голос нечем. */
  canRemember: boolean
  onClose: () => void
  onSave: (name: string, remember: boolean) => void
}) {
  const [name, setName] = useState('')
  const [remember, setRemember] = useState(true)
  // Слепки перечитываем на каждое открытие: голос могли запомнить только что,
  // на соседней записи.
  const { data: voices } = useAsync(() => api.call('voices:list'), [speaker?.id])

  useEffect(() => {
    setName(speaker?.name ?? '')
    setRemember(canRemember)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker?.id, canRemember])

  if (!speaker) return null
  const where = speaker.track === 'mic' ? t('говорит рядом с вами') : t('на том конце звонка')
  // Календарь уже знает, кого ждали на встрече: набирать имена руками незачем.
  const taken = new Set(meeting.speakers.map((s) => s.name).filter(Boolean))
  const suggestions = meeting.calendarParticipants.filter((p) => !taken.has(p))
  // Голоса, уже занятые другими участниками этой записи, не предлагаем: один
  // человек не может говорить в двух местах одновременно.
  const known = (voices ?? []).filter((v) => v.name === speaker.name || !taken.has(v.name))

  return (
    <Modal
      open={Boolean(speaker)}
      onClose={onClose}
      title={t('Кто это?')}
      actions={
        <>
          <Button onClick={onClose}>{t('Отмена')}</Button>
          <Button variant="primary" onClick={() => onSave(name, remember)} disabled={!name.trim()}>{t('Сохранить')}</Button>
        </>
      }
    >
      <p className="muted">
        {t('Участник {who} — {where}. В расшифровке у него {n} реплик.', { who: speakerLabel(speaker, speaker.id), where, n: meeting.utterances.filter((u) => u.speakerId === speaker.id).length })}
      </p>
      <Field label={t('Имя')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Например, Дима')} autoFocus />
      </Field>

      {/* Голос мог не узнаться: слепок шумный, реплик мало, человек говорил
          тише обычного. Тогда участника привязывают к уже знакомому голосу
          руками — выбором из списка, а не угадыванием написания имени. */}
      {known.length > 0 && (
        <div className="col" style={{ gap: 'var(--space-2)' }}>
          <span className="field__hint">{t('Знакомые голоса. Выберите, если это кто-то из них — слепок уточнится по этой записи:')}</span>
          <div className="chips">
            {known.map((voice) => (
              <button
                key={voice.id}
                className={`chip ${name.trim().toLowerCase() === voice.name.toLowerCase() ? 'chip--on' : ''}`}
                onClick={() => {
                  setName(voice.name)
                  setRemember(canRemember)
                }}
              >
                {voice.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="col" style={{ gap: 'var(--space-2)' }}>
          <span className="field__hint">{t('События из календаря. Нажмите, чтобы подставить:')}</span>
          <div className="chips">
            {suggestions.map((suggestion) => (
              <button key={suggestion} className="chip" onClick={() => setName(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
      {canRemember && (
        <label className="row" style={{ gap: 'var(--space-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span className="grow">{t('Запомнить голос')}<span className="dim">{t('— в следующий раз имя подставится само')}</span>
          </span>
        </label>
      )}
    </Modal>
  )
}

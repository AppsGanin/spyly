import { clipboard, ipcMain, shell, systemPreferences, app } from 'electron'
import { t,
  buildAgentPrompt,
  containment,
  isLikelyHallucination,
  learnedTerms,
  levelAt,
  micIsOwnVoice,
  mergeSpeakers,
  mergeUtterances,
  renderTranscriptMarkdown,
  SILENCE_RMS_THRESHOLD,
  splitUtterance,
  textSimilarity,
  utterancesInRange,
  type LevelWindow,
} from '@spyly/core'
import type {
  IpcChannel,
  IpcRequests,
  Permissions,
  RecordingState,
  StartRecordingOptions
} from '../../shared/ipc.js'
import {
  NativeCapture,
  appUsesMicrophone,
  checkSystemAudioPermission,
  isSupported,
  listApps,
  listMics
} from '../audio/native.js'
import { startCallDetector } from '../detect/calls.js'
import { checkForUpdatesNow, openReleases } from '../updates.js'
import { editWithHistory, forgetHistory, historyState, redo, undo } from '../store/history.js'
import { SpeechChunker, encodeWav } from '../pipeline/live.js'
import {
  LiveTranscriber,
  isLiveModelReady,
  releaseLiveModel,
  warmLiveModel,
  type LiveUpdate
} from '../pipeline/live-stream.js'
import { startWhisperServer, stopWhisperServer, transcribeChunk } from '../pipeline/whisper-server.js'
import { RecordingSession, idleState } from '../recorder/session.js'
import {
  deleteMeeting,
  hasAudio,
  listMeetings,
  readMeeting,
  readMeta,
  searchMeetings,
  updateMeeting,
  writeMeta
} from '../store/meetings.js'
import { existsSync } from 'node:fs'
import { appendFile, readFile, rm } from 'node:fs/promises'
import {
  deliverCaptureError,
  deliverCaptureReady,
  deliverSamples,
  rendererUsesMicrophone
} from '../audio/renderer-capture.js'
import { silenceRange } from '../audio/wav.js'
import { findRelated, forgetRelated } from '../store/related.js'
import { audioFile, meetingDir, meetingFile } from '../store/paths.js'
import { loadSettings, saveSettings } from '../store/settings.js'
import { encryptionAvailable, hasSecret, setSecret } from '../store/secrets.js'
import { send, setOverlayVisible, showMainWindow } from '../index.js'
import { trayActions, updateTray } from '../tray.js'
import { processMeeting } from '../pipeline/run.js'
import { listProviders } from '../providers/registry.js'
import { listModels, downloadModel, pauseDownload, cancelDownload, removeModel } from '../pipeline/models.js'
import { deleteVoice, finishEnrollment, listVoices, rememberSpeaker, startEnrollment } from '../store/voices.js'

let session: RecordingSession | null = null
let probes: NativeCapture[] = []
/** Режим детектора держим рядом: опрос не должен каждые пять секунд читать файл. */
let cachedDetectMode: 'off' | 'notify' | 'auto' = 'notify'

async function refreshDetectMode(): Promise<void> {
  cachedDetectMode = (await loadSettings()).autoDetectCalls
}

function currentState(): RecordingState {
  return session ? session.state() : idleState()
}

/** Идёт ли запись прямо сейчас — окну нужно знать, можно ли закрываться. */
export function isRecordingNow(): boolean {
  const status = currentState().status
  return status === 'recording' || status === 'paused'
}

/** Об уже показанной ошибке второй раз не сообщаем. */
let lastRecordingError: string | null = null

function broadcastState(): void {
  const state = currentState()

  // Ошибку записи раньше никто не показывал: она лежала в состоянии, а на
  // экране человек видел идущую запись и узнавал о беде только в конце.
  if (state.error && state.error !== lastRecordingError) {
    send('toast', { kind: 'error', text: state.error })
  }
  lastRecordingError = state.error

  send('rec:state', state)
  updateTray(state)
  // Панель поверх окон нужна ровно тогда, когда запись идёт — включая паузу:
  // на паузе как раз важно видеть, что запись не забыта.
  setOverlayVisible(state.status === 'recording' || state.status === 'paused')
}

async function permissions(): Promise<Permissions> {
  if (process.platform !== 'darwin') {
    // Windows и Linux спрашивают про микрофон сами при первом обращении, а
    // системный звук отдельного разрешения не требует вовсе. Отдельного API,
    // чтобы узнать состояние заранее, там нет — поэтому не выдумываем его и
    // не пугаем человека словом «отказано».
    return { microphone: 'not-determined', systemAudio: 'granted' }
  }
  const microphone = systemPreferences.getMediaAccessStatus('microphone') as Permissions['microphone']
  // У захвата системного звука нет API статуса: единственный способ узнать —
  // попробовать создать tap. Проба дешёвая и мгновенно сносится.
  const systemAudio = (await checkSystemAudioPermission()) ? 'granted' : 'denied'
  return { microphone, systemAudio }
}

/** Типобезопасная регистрация: имя канала и сигнатура берутся из контракта. */
function handle<C extends IpcChannel>(
  channel: C,
  fn: (...args: Parameters<IpcRequests[C]>) => ReturnType<IpcRequests[C]> | Promise<ReturnType<IpcRequests[C]>>
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as Parameters<IpcRequests[C]>))
    } catch (error) {
      // Без этого упавший обработчик виден только как молчащая кнопка: в
      // renderer прилетает отказ, а в журнале приложения — ничего.
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
      process.stderr.write(`[ipc:${channel}] ${text}\n`)
      throw error
    }
  })
}

/**
 * Живая расшифровка по ходу разговора.
 *
 * Звук идёт в потоковую модель непрерывно, и она уточняет текст каждые 320 мс:
 * слова появляются почти сразу и дописываются, пока человек говорит. Прежний
 * способ — копить речь до паузы и отдавать куском — показывал фразу целиком и
 * только после того, как она договорена, то есть с опозданием до десятка
 * секунд на монологе. Он остаётся запасным на случай, если потоковая модель
 * не скачана.
 *
 * Результат в любом случае черновой: после остановки файлы прогоняются
 * целиком, и это всегда точнее того, что можно понять по ходу речи.
 */
async function attachLiveTranscription(active: RecordingSession, language: string): Promise<void> {
  let stopped = false

  /**
   * Громкость обеих дорожек по времени.
   *
   * Главный признак эха — не текст, а уровень: голос из динамиков доходит до
   * микрофона ослабленным в несколько раз. На настоящей записи отношение
   * держалось около 0.20 и почти не колебалось, тогда как текст расходился
   * настолько, что по нему эхо узнавалось лишь в трёх случаях из пяти.
   */
  const levels: Record<'mic' | 'system', LevelWindow[]> = { mic: [], system: [] }
  const fed: Record<'mic' | 'system', number> = { mic: 0, system: 0 }

  /**
   * Что недавно сказал собеседник.
   *
   * Его голос звучит из динамиков, и микрофон записывает его вместе с вашим.
   * Без этой проверки одна и та же фраза появляется в живой расшифровке
   * дважды — и как ваша, и как собеседника.
   */
  const recentRemote: { text: string; at: number }[] = []

  const rms = (samples: Float32Array): number => {
    let sum = 0
    for (const value of samples) sum += value * value
    return Math.sqrt(sum / Math.max(1, samples.length))
  }

  const looksLikeEcho = (track: 'mic' | 'system', text: string, startSec: number, endSec: number): boolean => {
    if (track !== 'mic') return false

    // Правило то же, что и в финальной расшифровке: микрофон заметно тише
    // того, что играло в динамиках, — значит, он слышал их, а не человека.
    // Одно определение на оба пути, чтобы живой текст и итоговый не расходились.
    if (!micIsOwnVoice(levelAt(levels.mic, startSec, endSec), levelAt(levels.system, startSec, endSec))) {
      return true
    }

    return recentRemote.some(
      (item) =>
        // Эхо приходит почти одновременно с оригиналом; окно с запасом на
        // задержку динамиков и разное деление на куски.
        Math.abs(item.at - startSec) < 8 &&
        (textSimilarity(item.text, text) > 0.6 || containment(text, item.text) > 0.7)
    )
  }

  let counter = 0

  /**
   * Показать реплику и — если она закончена — записать в черновик на диске.
   *
   * Незаконченные на диск не идут: файл читает агент через MCP, и версии одной
   * растущей фразы там были бы мусором.
   */
  /** Показанные реплики: по ним видно, что уже нужно убирать, а не просто не показывать. */
  const shown = new Set<string>()

  const publish = (
    track: 'mic' | 'system',
    id: string,
    text: string,
    start: number,
    end: number,
    final: boolean
  ): void => {
    if (stopped) return

    // На тишине распознавание выдаёт строку из обучающих данных — титры вроде
    // «Субтитры сделал DimaTorzok». В финальной расшифровке это давно
    // отсеивается, а живая показывала как есть.
    if (looksLikeEcho(track, text, start, end) || isLikelyHallucination(text)) {
      // Фразу могли уже показать, пока она росла: отброшенное окончание
      // оставило бы её на экране навсегда — с мигающим курсором и без конца.
      if (shown.has(id)) {
        shown.delete(id)
        send('live:utterance', { id, meetingId: active.meetingId, track, text: '', start, end, final: true })
      }
      return
    }

    if (track === 'system' && final) {
      recentRemote.push({ text, at: start })
      if (recentRemote.length > 12) recentRemote.shift()
    }

    send('live:utterance', { id, meetingId: active.meetingId, track, text, start, end, final })
    if (final) shown.delete(id)
    else shown.add(id)
    if (!final) return
    void appendFile(
      meetingFile(active.meetingId, 'live.jsonl'),
      `${JSON.stringify({ track, text, start, end })}\n`
    ).catch(() => undefined)
  }

  const streaming = isLiveModelReady()
  const transcribers = new Map<'mic' | 'system', LiveTranscriber>()
  const segmentIds = new Map<'mic' | 'system', string>()
  const chunkers = new Map<'mic' | 'system', SpeechChunker>()

  if (!streaming) {
    // Без потоковой модели остаётся прежний способ: копить речь до паузы и
    // отдавать куском в whisper-server. Текст приходит с опозданием на фразу,
    // но лучше так, чем ничего.
    try {
      await startWhisperServer(language)
    } catch (error) {
      send('toast', { kind: 'info', text: `Живая расшифровка недоступна: ${String(error)}` })
      return
    }
  }

  /**
   * Успевает ли распознавание за речью.
   *
   * Потоковая модель считает прямо здесь, в главном процессе, а он же принимает
   * звук и пишет его в файл. На проверяемой машине уходит около 0.11 секунды
   * счёта на секунду звука с каждой дорожки — запас восьмикратный. Но машина
   * может оказаться слабее или занятой, и тогда важнее сохранить запись, чем
   * показывать текст: живую расшифровку выключаем, честно сказав почему.
   */
  let spentMs = 0
  let heardMs = 0
  const checkPace = (): void => {
    // Первые секунды не в счёт: в них попадает загрузка модели.
    if (heardMs < 20_000 || spentMs <= heardMs * 0.35) return
    stopped = true
    for (const live of transcribers.values()) {
      try {
        live.finish()
      } catch {
        // Уже неважно: живую расшифровку всё равно останавливаем.
      }
    }
    transcribers.clear()
    releaseLiveModel()
    send('toast', {
      kind: 'info',
      text: t('Живая расшифровка не успевает и остановлена, чтобы не мешать записи. Полный текст соберётся после остановки.')
    })
  }

  /** Отдать обновление от потоковой модели. */
  const onStreamUpdate = (track: 'mic' | 'system', update: LiveUpdate): void => {
    let id = segmentIds.get(track)
    if (!id) {
      id = `live-${track}-${counter++}`
      segmentIds.set(track, id)
    }
    publish(track, id, update.text, update.start, update.end, update.final)
    // Фраза закончена — следующая получит свой номер и встанет отдельной строкой.
    if (update.final) segmentIds.delete(track)
  }

  // --- запасной путь: нарезка по паузам и whisper-server ---

  let inFlight = 0
  const pending: { track: 'mic' | 'system'; samples: Float32Array; startSec: number }[] = []
  let dropped = 0
  let complainedAboutLoad = false

  const pump = (): void => {
    if (stopped) return
    // Два одновременных запроса — предел: дальше они просто встают в очередь
    // на сервере и увеличивают задержку.
    while (inFlight < 2 && pending.length > 0) {
      const item = pending.shift()!
      inFlight++
      const durationSec = item.samples.length / 16000
      void transcribeChunk(encodeWav(item.samples), language)
        .then((text) => {
          if (!text) return
          publish(
            item.track,
            `live-${item.track}-${counter++}`,
            text,
            item.startSec,
            item.startSec + durationSec,
            true
          )
        })
        .catch((error: unknown) => {
          // Раньше ошибка глоталась молча: сервер умирал, а живая расшифровка
          // просто переставала появляться — без единого слова о причине.
          if (stopped) return
          stopped = true
          send('toast', {
            kind: 'info',
            text: `Живая расшифровка остановилась: ${error instanceof Error ? error.message : String(error)}. Запись идёт, полный текст соберётся после остановки.`
          })
        })
        .finally(() => {
          inFlight--
          pump()
        })
    }
  }

  const makeChunker = (track: 'mic' | 'system') =>
    new SpeechChunker(track, (samples, startSec) => {
      if (stopped) return
      // Тишину не отправляем вовсе: так выдумка не появится в принципе, а
      // сервер не тратит время на пустые куски.
      if (rms(samples) < SILENCE_RMS_THRESHOLD) return
      pending.push({ track, samples, startSec })
      // Очередь глубже трёх означает, что машина не успевает: копить дальше
      // бессмысленно — текст приедет с опозданием на минуты.
      while (pending.length > 3) {
        pending.shift()
        dropped++
      }
      if (dropped > 5 && !complainedAboutLoad) {
        complainedAboutLoad = true
        send('toast', {
          kind: 'info',
          text: t('Живая расшифровка не успевает и показывает не всё. Полный текст соберётся после остановки записи.')
        })
      }
      pump()
    })

  active.on('samples', (track: 'mic' | 'system', chunk: Float32Array) => {
    // Уровни запоминаем по времени: по ним потом видно, что микрофон в этот
    // момент лишь повторял динамики.
    const start = fed[track] / 16000
    fed[track] += chunk.length
    const window = levels[track]
    window.push({ start, end: fed[track] / 16000, rms: rms(chunk) })
    // Минуты истории хватает: эхо приходит почти одновременно.
    while (window.length > 0 && start - window[0]!.start > 60) window.shift()

    if (stopped) return

    if (streaming) {
      let live = transcribers.get(track)
      if (!live) {
        try {
          live = new LiveTranscriber(track)
        } catch (error) {
          stopped = true
          send('toast', {
            kind: 'info',
            text: `Живая расшифровка не запустилась: ${error instanceof Error ? error.message : String(error)}. Полный текст соберётся после остановки.`
          })
          return
        }
        transcribers.set(track, live)
      }
      try {
        const started = Date.now()
        const update = live.push(chunk)
        spentMs += Date.now() - started
        heardMs += (chunk.length / 16000) * 1000
        if (update) onStreamUpdate(track, update)
        checkPace()
      } catch {
        // Один сбойный кусок не повод ронять живую расшифровку целиком.
      }
      return
    }

    let chunker = chunkers.get(track)
    if (!chunker) {
      chunker = makeChunker(track)
      chunkers.set(track, chunker)
    }
    chunker.push(chunk)
  })

  active.once('stopping', () => {
    for (const chunker of chunkers.values()) chunker.flush()
    for (const [track, live] of transcribers) {
      try {
        for (const tail of live.finish()) onStreamUpdate(track, tail)
      } catch {
        // Хвост фразы не критичен: полный проход всё равно перекроет черновик.
      }
    }
    transcribers.clear()
    // Модель весит полгигабайта — между записями держать её в памяти незачем.
    if (streaming) releaseLiveModel()
  })
}

/** Сколько времени запись считается «недавней» и её ещё можно продолжить. */

/**
 * Последняя запись, к которой разумно дописать продолжение.
 *
 * Созвон часто обрывается и возобновляется через пару минут: две отдельные
 * записи вместо одного разговора — лишняя работа для человека потом.
 */
async function startRecording(options: StartRecordingOptions): Promise<RecordingState> {
  if (session) return session.state()

  let pids: number[] = []
  if (options.systemApps?.length) {
    const apps = await listApps()
    pids = apps.filter((a) => options.systemApps!.includes(a.key)).flatMap((a) => a.pids)
  }

  let previous: { meta: Awaited<ReturnType<typeof readMeta>>; durationSec: number } | undefined
  if (options.continueMeetingId) {
    const meta = await readMeta(options.continueMeetingId)
    if (meta) previous = { meta, durationSec: meta.durationSec }
  }

  const next = new RecordingSession(
    options,
    pids,
    previous?.meta ? { meta: previous.meta, durationSec: previous.durationSec } : undefined
  )
  next.on('state', broadcastState)
  next.on('allTracksLost', () => {
    send('toast', { kind: 'error', text: t('Захват звука прервался — останавливаю запись') })
    void failsafeStop()
  })
  next.on('levels', (levels: { mic: number; system: number }) => send('audio:levels', levels))
  session = next

  const settings = await loadSettings()
  try {
    await next.start()
    // Черновик прошлой части чистим: при продолжении записи отсчёт времени
    // начинается заново, и склеенный файл дал бы агенту мешанину.
    await rm(meetingFile(next.meetingId, 'live.jsonl'), { force: true })
    if (settings.liveTranscription) void attachLiveTranscription(next, settings.language)
  } catch (error) {
    session = null
    const message = error instanceof Error ? error.message : String(error)
    send('toast', { kind: 'error', text: t('Не удалось начать запись: {message}', { message: message }) })
    throw error
  }
  // Встреча создаётся на диске сразу, но список в интерфейсе сам об этом не
  // узнает: без этого события live-расшифровку было бы негде смотреть до
  // самой остановки записи.
  send('meetings:changed', { id: next.meetingId })
  broadcastState()
  return next.state()
}

/**
 * Остановка «на всякий случай» — из обработчиков, которым нечего делать с
 * ошибкой. Молчать нельзя: если остановить не вышло, запись всё ещё идёт, и
 * человек должен об этом узнать.
 */
async function failsafeStop(): Promise<void> {
  try {
    await stopRecording()
  } catch (error) {
    send('toast', {
      kind: 'error',
      text: `Не удалось остановить запись: ${error instanceof Error ? error.message : String(error)}`
    })
  }
}

async function stopRecording(): Promise<{ meetingId: string | null }> {
  const active = session
  if (!active) return { meetingId: null }

  const { durationSec } = await active.stop()
  stopWhisperServer()
  session = null
  broadcastState()

  const meta = await readMeta(active.meetingId)
  if (meta) {
    await writeMeta({
      ...meta,
      endedAt: new Date().toISOString(),
      durationSec,
      marks: active.currentMarks(),
      stages: { ...meta.stages, recording: durationSec > 0 ? 'done' : 'failed' }
    })
  }
  send('meetings:changed', { id: active.meetingId })

  if (durationSec < 1) {
    send('toast', { kind: 'error', text: t('Запись оказалась пустой — звук не поступал') })
    return { meetingId: active.meetingId }
  }

  // Расшифровка идёт фоном: пользователь сразу возвращается к списку встреч.
  void processMeeting(active.meetingId).catch((error: unknown) => {
    send('toast', { kind: 'error', text: `Обработка не удалась: ${String(error)}` })
  })

  return { meetingId: active.meetingId }
}

function stopProbes(): void {
  for (const probe of probes) probe.stop()
  probes = []
}

/**
 * Переключение записи горячей клавишей.
 *
 * Останавливаем сразу, а начинаем с источниками по умолчанию: в момент, когда
 * разговор уже идёт, выбирать микрофон некогда.
 */
export function toggleRecordingFromShortcut(): void {
  if (session) {
    void failsafeStop()
    return
  }
  void startRecording({ mic: true, system: true })
    .then(() => showMainWindow())
    .catch(() => undefined)
}

/** Только для проверочных прогонов: начать запись без участия интерфейса. */
export async function autoStartForCheck(): Promise<void> {
  await startRecording({ mic: true, system: true, title: 'Проверка интерфейса' })
}

export function registerIpc(): void {
  trayActions.onShowWindow = showMainWindow

  // Детектор созвонов читает режим из настроек на каждом опросе, поэтому
  // переключение в интерфейсе действует сразу и перезапуск не нужен.
  startCallDetector({
    mode: () => cachedDetectMode,
    // Микрофон занимаем и мы сами — на записи слепка голоса и на проверке
    // звука. Предлагать записать разговор в ответ на собственные действия
    // приложения нельзя.
    isRecording: () => session !== null || appUsesMicrophone() || rendererUsesMicrophone(),
    onDetected: ({ app, auto }) => {
      send('call:detected', { app, at: Date.now() })
      if (auto) {
        void startRecording({ mic: true, system: true, title: t('Запись · {app}', { app: app }) })
      } else {
        showMainWindow()
      }
    }
  })
  void refreshDetectMode()
  trayActions.onToggleRecording = () => {
    if (session) void failsafeStop()
    else void startRecording({ mic: true, system: true })
  }

  handle('app:permissions', permissions)

  handle('app:requestPermission', async (which) => {
    if (process.platform === 'darwin') {
      if (which === 'microphone') {
        await systemPreferences.askForMediaAccess('microphone')
      } else {
        // Диалог захвата системного звука показывает сама CoreAudio при первой
        // попытке создать tap — отдельного API запроса у macOS нет.
        await checkSystemAudioPermission()
      }
    }
    return permissions()
  })

  handle('app:openPrivacySettings', (which) => {
    const panes: Record<typeof which, string> = {
      microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      systemAudio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      calendar: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'
    }
    void shell.openExternal(panes[which])
  })

  handle('app:version', () => ({
    app: app.getVersion(),
    electron: process.versions.electron ?? '',
    platform: `${process.platform} ${process.arch}`
  }))

  handle('app:checkUpdates', () => checkForUpdatesNow())
  handle('app:openReleases', () => openReleases())

  handle('calendar:status', async () => {
    const { calendarGranted } = await import('../detect/calendar.js')
    return { supported: process.platform === 'darwin', granted: await calendarGranted() }
  })

  handle('calendar:request', async () => {
    const { requestCalendarAccess } = await import('../detect/calendar.js')
    const granted = await requestCalendarAccess()
    // Раньше отправляли в настройки только при явном отказе. Но система может
    // и вовсе не показать своё окно — тогда состояние остаётся «не спрашивали»,
    // и человек упирается в кнопку, которая ничего не делает. Поэтому любой
    // неуспех ведёт в настройки: там доступ выдаётся руками и наверняка.
    return { granted, needsSettings: !granted }
  })

  handle('calendar:current', async () => {
    const { likelyEvent } = await import('../detect/calendar.js')
    const event = await likelyEvent()
    return event
      ? {
          id: event.id,
          title: event.title,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          participants: event.participants,
          isNow: event.isNow
        }
      : null
  })

  handle('audio:listMics', () => listMics())
  handle('audio:listApps', () => listApps())

  handle('audio:startProbe', async (opts) => {
    stopProbes()
    if (!isSupported()) return

    // Модель для живой расшифровки грузится секунды. Прогреваем её, пока
    // пользователь выбирает источники: иначе начало созвона осталось бы без
    // текста. Whisper-сервер поднимаем только когда потоковой модели нет:
    // он держит в памяти полтора гигабайта, и зря такое не занимают.
    void loadSettings().then((s) => {
      if (!s.liveTranscription) return
      if (isLiveModelReady()) setTimeout(() => warmLiveModel(), 0).unref?.()
      else void startWhisperServer(s.language).catch(() => undefined)
    })
    const mic = new NativeCapture({ source: 'mic', micDeviceId: opts.micDeviceId })
    let systemPids: number[] = []
    if (opts.systemApps?.length) {
      const apps = await listApps()
      systemPids = apps.filter((a) => opts.systemApps!.includes(a.key)).flatMap((a) => a.pids)
    }
    const system = new NativeCapture({
      source: 'system',
      includePids: systemPids.length ? systemPids : undefined,
      excludePids: systemPids.length ? undefined : [process.pid]
    })
    probes = [mic, system]
    const levels = { mic: 0, system: 0 }
    mic.on('level', (rms: number) => {
      levels.mic = rms
      send('audio:levels', { ...levels })
    })
    system.on('level', (rms: number) => {
      levels.system = rms
      send('audio:levels', { ...levels })
    })
    mic.on('error', (message: string) => send('toast', { kind: 'error', text: t('Микрофон: {message}', { message: message }) }))
    system.on('error', (message: string) => send('toast', { kind: 'error', text: t('Системный звук: {message}', { message: message }) }))
    mic.start()
    system.start()
  })

  handle('audio:stopProbe', () => {
    stopProbes()
    // Если запись так и не началась, держать модели в памяти незачем: вместе
    // они занимают под два гигабайта, а диалог выбора источников открывают и
    // закрывают чаще, чем пишут разговор.
    setTimeout(() => {
      if (session) return
      stopWhisperServer()
      releaseLiveModel()
    }, 60_000).unref?.()
  })

  handle('rec:start', (opts) => startRecording(opts))
  handle('rec:stop', () => stopRecording())
  handle('rec:pause', () => {
    session?.pause()
    return currentState()
  })
  handle('rec:resume', () => {
    session?.resume()
    return currentState()
  })
  handle('rec:state', () => currentState())

  handle('rec:mark', (note) => session?.mark(note ?? '') ?? null)
  handle('rec:markNote', (id, note) => session?.annotate(id, note))

  // Звук, пришедший из renderer: на Windows и Linux захват живёт там.
  handle('capture:samples', (track, pcm) => {
    deliverSamples(track, new Float32Array(pcm))
  })
  handle('capture:ready', (track) => deliverCaptureReady(track))
  handle('capture:failed', (track, message) => deliverCaptureError(track, message))

  handle('meetings:list', () => listMeetings())
  handle('meetings:get', (id) => readMeeting(id))
  handle('meetings:search', (query) => searchMeetings(query))

  handle('meetings:delete', async (id) => {
    await deleteMeeting(id)
    forgetRelated(id)
    send('meetings:changed', { id })
  })

  handle('meetings:update', async (id, patch) => {
    // Через общую очередь правок: раньше здесь были отдельные чтение и запись,
    // и правка, пришедшая между ними, терялась — в том числе от конвейера,
    // который дописывает запись по ходу обработки.
    const next = await editWithHistory(
      id,
      patch.title !== undefined ? t('переименование') : t('правку сведений'),
      (meeting) => {
        // Человек назвал запись сам — больше её не переименовываем.
        const renamed = patch.title !== undefined && patch.title !== meeting.title
        return { ...meeting, ...patch, id: meeting.id, titleAuto: renamed ? false : meeting.titleAuto }
      }
    )
    send('meetings:changed', { id })
    return next
  })

  handle('edit:history', (id) => historyState(id))

  handle('edit:undo', async (id) => {
    const done = await undo(id)
    if (done) send('meetings:changed', { id })
    return done
  })

  handle('edit:redo', async (id) => {
    const done = await redo(id)
    if (done) send('meetings:changed', { id })
    return done
  })

  handle('meetings:renameSpeaker', async (id, speakerId, name, rememberVoice) => {
    const next = await editWithHistory(id, t('имя участника'), (meeting) => {
      const clean = name.trim()
      const speakers = meeting.speakers.map((s) =>
        s.id === speakerId ? { ...s, name: clean || undefined, nameSource: 'manual' as const } : s
      )

      // Разделение по голосам иногда дробит одного человека на нескольких.
      // Назвать их одним именем — это и есть «они один и тот же»: сводим их,
      // иначе человек остался бы в списке дважды, а его доля в разговоре
      // делилась бы пополам.
      const track = speakers.find((s) => s.id === speakerId)?.track
      const twin = clean
        ? speakers.find((s) => s.id !== speakerId && s.name === clean && s.track === track)
        : undefined
      if (!twin) return { ...meeting, speakers }
      return mergeSpeakers({ ...meeting, speakers }, speakerId, twin.id)
    })
    if (rememberVoice) await rememberSpeaker(id, speakerId, name)
    send('meetings:changed', { id })
    return next
  })

  handle('meetings:editUtterance', async (id, utteranceId, text) => {
    let before = ''
    const next = await editWithHistory(id, t('правку реплики'), (meeting) => {
      before = meeting.utterances.find((u) => u.id === utteranceId)?.text ?? ''
      return {
        ...meeting,
        utterances: meeting.utterances.map((u) => (u.id === utteranceId ? { ...u, text } : u))
      }
    })
    send('meetings:changed', { id })
    // Правка — самый честный источник терминов: человек только что показал,
    // как слово должно выглядеть на самом деле.
    const settings = await loadSettings()
    return { meeting: next, terms: learnedTerms(before, text, settings.vocabulary) }
  })

  handle('vocab:add', async (terms) => {
    const settings = await loadSettings()
    const known = new Set(settings.vocabulary.map((t) => t.toLowerCase()))
    const added = terms.map((t) => t.trim()).filter((t) => t && !known.has(t.toLowerCase()))
    if (added.length === 0) return settings.vocabulary
    const next = await saveSettings({ vocabulary: [...settings.vocabulary, ...added] })
    return next.vocabulary
  })

  handle('meetings:splitUtterance', async (id, utteranceId, charIndex) => {
    const next = await editWithHistory(id, t('разделение реплики'), (meeting) => {
      const index = meeting.utterances.findIndex((u) => u.id === utteranceId)
      if (index === -1) throw new Error(t('реплика не найдена'))
      const taken = new Set(meeting.utterances.map((u) => u.id))
      const parts = splitUtterance(meeting.utterances[index]!, charIndex, taken)
      if (!parts) throw new Error(t('в этом месте делить нечего'))
      return {
        ...meeting,
        utterances: [...meeting.utterances.slice(0, index), ...parts, ...meeting.utterances.slice(index + 1)]
      }
    })
    send('meetings:changed', { id })
    return next
  })

  handle('meetings:mergeUtterance', async (id, utteranceId) => {
    const next = await editWithHistory(id, t('склейку реплик'), (meeting) => {
      const index = meeting.utterances.findIndex((u) => u.id === utteranceId)
      if (index === -1) throw new Error(t('реплика не найдена'))
      const second = meeting.utterances[index + 1]
      if (!second) throw new Error(t('это последняя реплика — склеивать не с чем'))
      const merged = mergeUtterances(meeting.utterances[index]!, second)
      return {
        ...meeting,
        utterances: [...meeting.utterances.slice(0, index), merged, ...meeting.utterances.slice(index + 2)]
      }
    })
    send('meetings:changed', { id })
    return next
  })

  handle('meetings:reassignUtterance', async (id, utteranceId, speakerId) => {
    const next = await editWithHistory(id, t('смену говорящего'), (meeting) => {
      if (!meeting.speakers.some((s) => s.id === speakerId)) throw new Error(t('такого участника нет'))
      return {
        ...meeting,
        utterances: meeting.utterances.map((u) => (u.id === utteranceId ? { ...u, speakerId } : u))
      }
    })
    send('meetings:changed', { id })
    return next
  })

  /**
   * Вырезание фрагмента.
   *
   * Звук заменяется тишиной, а не укорачивается: сдвиг длительности переломал
   * бы все таймкоды, отметки и уже собранный конспект. Для задачи «убрать
   * лишнее из записи» тишина решает ровно то же — слов там больше нет.
   */
  handle('meetings:removeRange', async (id, from, to) => {
    forgetHistory(id)
    const [a, b] = from <= to ? [from, to] : [to, from]

    for (const track of ['mic', 'system'] as const) {
      const file = audioFile(id, track)
      if (existsSync(file)) await silenceRange(file, a, b)
    }
    await rm(audioFile(id, 'mix'), { force: true })

    let removed = 0
    const next = await updateMeeting(id, (meeting) => {
      const doomed = new Set(utterancesInRange(meeting, a, b).map((u) => u.id))
      removed = doomed.size
      return {
        ...meeting,
        utterances: meeting.utterances.filter((u) => !doomed.has(u.id)),
        marks: meeting.marks.filter((m) => m.at < a || m.at > b)
      }
    })
    send('meetings:changed', { id })
    return { meeting: next, removed }
  })

  handle('meetings:related', (id) => findRelated(id))

  /**
   * Черновик живой расшифровки.
   *
   * Остаётся после записи намеренно: по нему видно, что было на экране во
   * время разговора. Финальная расшифровка точнее, но черновик показывает
   * происходившее так, как его видел человек, — и иногда это важнее.
   */
  handle('meetings:live', async (id) => {
    const file = meetingFile(id, 'live.jsonl')
    if (!existsSync(file)) return []
    try {
      const raw = await readFile(file, 'utf8')
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { track: 'mic' | 'system'; text: string; start: number; end: number })
        .sort((a, b) => a.start - b.start)
    } catch {
      // Черновик — вспомогательные данные: битый файл не повод показывать ошибку.
      return []
    }
  })

  handle('meetings:updateSummary', async (id, summary) => {
    // Правку помечаем моделью «вручную»: потом видно, что это не машина.
    const next = await editWithHistory(id, t('правку конспекта'), (meeting) => ({
      ...meeting,
      summary: { ...summary, model: t('вручную') }
    }))
    send('meetings:changed', { id })
    return next
  })

  handle('meetings:reprocess', async (id, from) => {
    void processMeeting(id, from).catch((error: unknown) => {
      send('toast', { kind: 'error', text: `Обработка не удалась: ${String(error)}` })
    })
  })

  handle('meetings:audioPath', (id, track) => (hasAudio(id, track) ? audioFile(id, track) : null))

  handle('export:markdown', async (id) => {
    const meeting = await readMeeting(id)
    return meeting ? renderTranscriptMarkdown(meeting) : ''
  })

  handle('export:copyPrompt', async (id, templateId) => {
    const meeting = await readMeeting(id)
    if (!meeting) throw new Error(t('встреча не найдена'))
    const settings = await loadSettings()
    const template =
      settings.promptTemplates.find((t) => t.id === templateId) ?? settings.promptTemplates[0]
    if (!template) throw new Error(t('нет ни одного шаблона промпта'))
    const prompt = buildAgentPrompt({ template, meeting })
    clipboard.writeText(prompt)
    send('toast', { kind: 'success', text: t('Промпт скопирован') })
    return prompt
  })

  handle('export:revealFolder', (id) => {
    void shell.openPath(meetingDir(id))
  })

  handle('agents:status', async () => {
    const { agentStatuses } = await import('../export/agents.js')
    return agentStatuses()
  })

  handle('agents:verify', async () => {
    const { verifyServer } = await import('../export/agents.js')
    return verifyServer()
  })

  handle('agents:setConnection', async (id, connect) => {
    const { setAgentConnection } = await import('../export/agents.js')
    return setAgentConnection(id, connect)
  })

  handle('settings:get', () => loadSettings())
  handle('settings:set', async (patch) => {
    const next = await saveSettings(patch)
    cachedDetectMode = next.autoDetectCalls
    if (patch.theme) {
      const { nativeTheme } = await import('electron')
      nativeTheme.themeSource = next.theme
    }
    return next
  })
  handle('settings:providers', () => listProviders())

  handle('settings:hasKey', async (id) => ({
    // Само значение наружу не отдаём никогда: интерфейсу достаточно знать,
    // что ключ есть, а показать его он всё равно не должен.
    present: await hasSecret(id),
    encrypted: encryptionAvailable()
  }))

  handle('settings:setKey', async (id, value) => {
    await setSecret(id, value.trim())
  })

  handle('models:list', () => listModels())
  handle('models:download', (id) => {
    // Загрузка живёт своей жизнью: интерфейс не должен ждать её окончания.
    void downloadModel(id).catch(() => undefined)
  })
  handle('models:pause', (id) => pauseDownload(id))
  handle('models:cancel', (id) => cancelDownload(id))
  handle('models:remove', (id) => removeModel(id))

  handle('voices:ready', async () => {
    const { sherpaDiarizationProvider } = await import('../providers/diarization/sherpa.js')
    const status = await sherpaDiarizationProvider.ready().catch(() => ({ ready: false }))
    return status.ready
      ? { ready: true }
      : { ready: false, hint: t('нужна модель слепков голоса — скачайте её в настройках') }
  })

  handle('voices:list', () => listVoices())
  handle('voices:delete', (id) => deleteVoice(id))
  handle('voices:enrollStart', () => startEnrollment())
  handle('voices:enrollStop', (name) => finishEnrollment(name))

  // Главное окно во время записи могут закрыть — приложение живёт в трее. Но
  // плавающая панель остаётся на экране, и её таймер не должен замирать,
  // поэтому шлём состояние, пока есть запись, а не пока есть окно.
  setInterval(() => {
    if (session) broadcastState()
  }, 1000).unref?.()
}

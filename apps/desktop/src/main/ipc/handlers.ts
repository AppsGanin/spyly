import { clipboard, ipcMain, shell, systemPreferences, app } from 'electron'
import { t,
  buildAgentPrompt,
  containment,
  isLikelyHallucination,
  learnedTerms,
  levelAt,
  MANUAL_SUMMARY_MODEL,
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
/** The detector mode is kept close by: polling should not read a file every five seconds. */
let cachedDetectMode: 'off' | 'notify' | 'auto' = 'notify'

async function refreshDetectMode(): Promise<void> {
  cachedDetectMode = (await loadSettings()).autoDetectCalls
}

function currentState(): RecordingState {
  return session ? session.state() : idleState()
}

/** Whether a recording is running right now: the window needs to know whether it may close. */
export function isRecordingNow(): boolean {
  const status = currentState().status
  return status === 'recording' || status === 'paused'
}

/** An error already shown is not reported a second time. */
let lastRecordingError: string | null = null

function broadcastState(): void {
  const state = currentState()

  // Nobody used to show a recording error: it sat in the state while on screen
  // the person saw a recording running, and learned of the trouble only at the end.
  if (state.error && state.error !== lastRecordingError) {
    send('toast', { kind: 'error', text: state.error })
  }
  lastRecordingError = state.error

  send('rec:state', state)
  updateTray(state)
  // The panel above other windows is needed exactly while a recording runs,
  // pause included: on pause it matters most to see the recording is not forgotten.
  setOverlayVisible(state.status === 'recording' || state.status === 'paused')
}

async function permissions(): Promise<Permissions> {
  if (process.platform !== 'darwin') {
    // Windows and Linux ask about the microphone themselves on first use, and
    // system audio needs no separate permission at all. There is no API there to
    // learn the state in advance, so we do not invent one and do not frighten
    // anyone with the word "denied".
    return { microphone: 'not-determined', systemAudio: 'granted' }
  }
  const microphone = systemPreferences.getMediaAccessStatus('microphone') as Permissions['microphone']
  // System audio capture has no status API: the only way to find out is to try
  // creating a tap. The probe is cheap and torn down immediately.
  const systemAudio = (await checkSystemAudioPermission()) ? 'granted' : 'denied'
  return { microphone, systemAudio }
}

/** Type-safe registration: the channel name and signature come from the contract. */
function handle<C extends IpcChannel>(
  channel: C,
  fn: (...args: Parameters<IpcRequests[C]>) => ReturnType<IpcRequests[C]> | Promise<ReturnType<IpcRequests[C]>>
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as Parameters<IpcRequests[C]>))
    } catch (error) {
      // Without this a failed handler shows only as a button that does nothing: the
      // renderer gets a rejection and the application log gets nothing.
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
      process.stderr.write(`[ipc:${channel}] ${text}\n`)
      throw error
    }
  })
}

/**
 * Live transcription as the conversation goes.
 *
 * Audio flows into a streaming model continuously, and it refines the text
 * every 320 ms: words appear almost at once and are extended while a person
 * speaks. The previous approach, collecting speech until a pause and handing
 * it over in one lump, showed a phrase whole and only once it was finished,
 * which on a monologue meant up to ten seconds late. It stays as a fallback
 * in case the streaming model has not been downloaded.
 *
 * Either way the result is a draft: once recording stops the files are run
 * through whole, and that is always more accurate than anything that can be
 * made out mid-speech.
 */
async function attachLiveTranscription(active: RecordingSession, language: string): Promise<void> {
  let stopped = false

  /**
   * The level of both tracks over time.
   *
   * The main sign of echo is not the text but the level: a voice from the
   * speakers reaches the microphone several times quieter. On a real recording
   * the ratio held around 0.20 and barely wavered, whereas the text diverged so
   * far that echo could be recognised by it in only three cases out of five.
   */
  const levels: Record<'mic' | 'system', LevelWindow[]> = { mic: [], system: [] }
  const fed: Record<'mic' | 'system', number> = { mic: 0, system: 0 }

  /**
   * What the other side said recently.
   *
   * Their voice comes out of the speakers, and the microphone records it along
   * with yours. Without this check the same phrase appears twice in the live
   * transcript, once as yours and once as theirs.
   */
  const recentRemote: { text: string; at: number }[] = []

  const rms = (samples: Float32Array): number => {
    let sum = 0
    for (const value of samples) sum += value * value
    return Math.sqrt(sum / Math.max(1, samples.length))
  }

  const looksLikeEcho = (track: 'mic' | 'system', text: string, startSec: number, endSec: number): boolean => {
    if (track !== 'mic') return false

    // The rule is the same as in the final transcript: the microphone is markedly
    // quieter than what was playing through the speakers, so it was hearing them
    // rather than a person.
    // One definition for both paths, so that the live text and the final one do not diverge.
    if (!micIsOwnVoice(levelAt(levels.mic, startSec, endSec), levelAt(levels.system, startSec, endSec))) {
      return true
    }

    return recentRemote.some(
      (item) =>
        // Echo arrives almost at the same time as the original; the window allows for
        // speaker latency and for the two sides being cut into chunks differently.
        Math.abs(item.at - startSec) < 8 &&
        (textSimilarity(item.text, text) > 0.6 || containment(text, item.text) > 0.7)
    )
  }

  let counter = 0

  /**
   * Show an utterance and, if it is finished, write it into the draft on disk.
   *
   * Unfinished ones do not go to disk: the file is read by an agent over MCP,
   * and versions of one growing phrase would be rubbish there.
   */
  /** Utterances already shown: they tell us what has to be removed rather than merely not shown. */
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

    // On silence, recognition emits a string out of its training data, credits
    // along the lines of "Subtitles by DimaTorzok". The final transcript has
    // filtered that out for a long time; the live one showed it as is.
    if (looksLikeEcho(track, text, start, end) || isLikelyHallucination(text)) {
      // The phrase may already have been shown while it was growing: a discarded
      // ending would leave it on screen forever, with a blinking cursor and no end.
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
    // Without the streaming model the old approach remains: collect speech until
    // a pause and hand it to whisper-server in one lump. The text arrives a phrase
    // late, but that beats nothing.
    try {
      await startWhisperServer(language)
    } catch (error) {
      send('toast', { kind: 'info', text: t('Живая расшифровка недоступна: {error}', { error: String(error) }) })
      return
    }
  }

  /**
   * Whether recognition keeps up with speech.
   *
   * The streaming model computes right here, in the main process, and the same
   * process takes in audio and writes it to a file. On the machine this was
   * measured on it costs around 0.11 seconds of computation per second of audio
   * from each track, an eightfold margin. But the machine may turn out to be
   * weaker or busy, and then keeping the recording matters more than showing
   * text: live transcription is switched off, with an honest reason.
   */
  let spentMs = 0
  let heardMs = 0
  const checkPace = (): void => {
    // The first seconds do not count: they include loading the model.
    if (heardMs < 20_000 || spentMs <= heardMs * 0.35) return
    stopped = true
    for (const live of transcribers.values()) {
      try {
        live.finish()
      } catch {
        // It no longer matters: live transcription is being stopped anyway.
      }
    }
    transcribers.clear()
    releaseLiveModel()
    send('toast', {
      kind: 'info',
      text: t('Живая расшифровка не успевает и остановлена, чтобы не мешать записи. Полный текст соберётся после остановки.')
    })
  }

  /** Hand over an update from the streaming model. */
  const onStreamUpdate = (track: 'mic' | 'system', update: LiveUpdate): void => {
    let id = segmentIds.get(track)
    if (!id) {
      id = `live-${track}-${counter++}`
      segmentIds.set(track, id)
    }
    publish(track, id, update.text, update.start, update.end, update.final)
    // The phrase is finished; the next one gets its own number and its own line.
    if (update.final) segmentIds.delete(track)
  }

  // --- fallback path: cutting at pauses and whisper-server ---

  let inFlight = 0
  const pending: { track: 'mic' | 'system'; samples: Float32Array; startSec: number }[] = []
  let dropped = 0
  let complainedAboutLoad = false

  const pump = (): void => {
    if (stopped) return
    // Two requests at once is the limit: beyond that they simply queue on the
    // server and add to the delay.
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
          // The error used to be swallowed silently: the server died and live
          // transcription simply stopped appearing, without a word about why.
          if (stopped) return
          stopped = true
          send('toast', {
            kind: 'info',
            text: t('Живая расшифровка остановилась: {error}. Запись идёт, полный текст соберётся после остановки.', { error: error instanceof Error ? error.message : String(error) })
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
      // Silence is not sent at all: that way invented text cannot appear in the
      // first place, and the server wastes no time on empty chunks.
      if (rms(samples) < SILENCE_RMS_THRESHOLD) return
      pending.push({ track, samples, startSec })
      // A queue deeper than three means the machine is not keeping up: collecting
      // more is pointless, the text would arrive minutes late.
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
    // Levels are remembered against time: later they show that at that moment the
    // microphone was only repeating the speakers.
    const start = fed[track] / 16000
    fed[track] += chunk.length
    const window = levels[track]
    window.push({ start, end: fed[track] / 16000, rms: rms(chunk) })
    // A minute of history is enough: echo arrives almost simultaneously.
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
            text: t('Живая расшифровка не запустилась: {error}. Полный текст соберётся после остановки.', { error: error instanceof Error ? error.message : String(error) })
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
        // One bad chunk is no reason to bring live transcription down entirely.
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
        // The tail of a phrase is not critical: the full pass will cover the draft anyway.
      }
    }
    transcribers.clear()
    // The model weighs half a gigabyte; no reason to hold it in memory between recordings.
    if (streaming) releaseLiveModel()
  })
}

/** How long a recording counts as "recent" and can still be continued. */

/**
 * The last recording it makes sense to append a continuation to.
 *
 * A call often breaks off and resumes a couple of minutes later: two separate
 * recordings instead of one conversation is extra work for a person afterwards.
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
    // The draft of the previous part is cleared: when a recording is continued the
    // clock starts again, and a glued-together file would give an agent a muddle.
    await rm(meetingFile(next.meetingId, 'live.jsonl'), { force: true })
    if (settings.liveTranscription) void attachLiveTranscription(next, settings.language)
  } catch (error) {
    session = null
    const message = error instanceof Error ? error.message : String(error)
    send('toast', { kind: 'error', text: t('Не удалось начать запись: {message}', { message: message }) })
    throw error
  }
  // The meeting is created on disk at once, but the list in the interface does
  // not learn of it by itself: without this event there would be nowhere to
  // watch the live transcript until the recording stopped.
  send('meetings:changed', { id: next.meetingId })
  broadcastState()
  return next.state()
}

/**
 * A stop "just in case", from handlers that have nothing to do with the error.
 * Staying silent will not do: if stopping failed, the recording is still
 * running and the person has to find out.
 */
async function failsafeStop(): Promise<void> {
  try {
    await stopRecording()
  } catch (error) {
    send('toast', {
      kind: 'error',
      text: t('Не удалось остановить запись: {error}', { error: error instanceof Error ? error.message : String(error) })
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

  // Transcription runs in the background: the user goes straight back to the meeting list.
  void processMeeting(active.meetingId).catch((error: unknown) => {
    send('toast', { kind: 'error', text: t('Обработка не удалась: {error}', { error: String(error) }) })
  })

  return { meetingId: active.meetingId }
}

function stopProbes(): void {
  for (const probe of probes) probe.stop()
  probes = []
}

/**
 * Toggling a recording with a shortcut.
 *
 * Stopping happens at once, starting uses the default sources: at the moment a
 * conversation is already under way there is no time to pick a microphone.
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

/** For test runs only: start a recording without the interface being involved. */
export async function autoStartForCheck(): Promise<void> {
  await startRecording({ mic: true, system: true, title: 'Interface check' })
}

export function registerIpc(): void {
  trayActions.onShowWindow = showMainWindow

  // The call detector reads the mode from settings on every poll, so switching
  // it in the interface takes effect at once and needs no restart.
  startCallDetector({
    mode: () => cachedDetectMode,
    // We take the microphone ourselves too, while recording a voice print and
    // during the sound check. Offering to record a conversation in response to
    // the application's own actions will not do.
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
        // The system audio capture dialog is shown by CoreAudio itself on the first
        // attempt to create a tap; macOS has no separate request API.
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
    // We used to send people to settings only on an outright refusal. But the
    // system may not show its dialog at all, and then the state stays "not asked"
    // and a person is stuck against a button that does nothing. So any failure
    // leads to settings: there access is granted by hand and for certain.
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

    // The model for live transcription takes seconds to load. It is warmed up
    // while the user picks sources: otherwise the start of a call would have no
    // text. The whisper server is only started when there is no streaming model:
    // it holds a gigabyte and a half in memory, which is not to be taken lightly.
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
    // If a recording never started, there is no point holding models in memory:
    // together they take close to two gigabytes, and the source picker is opened
    // and closed more often than a conversation is recorded.
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

  // Audio arriving from the renderer: on Windows and Linux capture lives there.
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
    // Through the shared edit queue: this used to be a separate read and write,
    // and an edit arriving between them was lost, including one from the pipeline
    // that fills a recording in as processing goes.
    const next = await editWithHistory(
      id,
      patch.title !== undefined ? t('переименование') : t('правку сведений'),
      (meeting) => {
        // The person named the recording themselves, so we stop renaming it.
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

      // Voice separation sometimes breaks one person into several. Giving them one
      // name is exactly the statement "these are the same person": they are merged,
      // otherwise the person would sit in the list twice and their share of the
      // conversation would be halved.
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
    // An edit is the most honest source of terms: the person has just shown how
    // the word is really meant to look.
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
   * Cutting out a fragment.
   *
   * The audio is replaced with silence rather than shortened: a shift in
   * duration would break every timestamp, every mark and the summary already
   * assembled. For "take this out of the recording" silence does exactly the
   * same job, as the words are no longer there.
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
   * The draft from live transcription.
   *
   * It is kept after a recording on purpose: it shows what was on screen during
   * the conversation. The final transcript is more accurate, but the draft shows
   * what happened the way a person saw it, and sometimes that matters more.
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
      // The draft is auxiliary data: a broken file is no reason to show an error.
      return []
    }
  })

  handle('meetings:updateSummary', async (id, summary) => {
    // Marked as edited by a person, with a value that is never translated: the
    // interface compares against it, and a translated marker stopped matching.
    const next = await editWithHistory(id, t('правку конспекта'), (meeting) => ({
      ...meeting,
      summary: { ...summary, model: MANUAL_SUMMARY_MODEL }
    }))
    send('meetings:changed', { id })
    return next
  })

  handle('meetings:reprocess', async (id, from) => {
    void processMeeting(id, from).catch((error: unknown) => {
      send('toast', { kind: 'error', text: t('Обработка не удалась: {error}', { error: String(error) }) })
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
    // The value itself is never handed out: the interface only needs to know the
    // key exists, and should not show it in any case.
    present: await hasSecret(id),
    encrypted: encryptionAvailable()
  }))

  handle('settings:setKey', async (id, value) => {
    await setSecret(id, value.trim())
  })

  handle('models:list', () => listModels())
  handle('models:download', (id) => {
    // The download lives its own life: the interface must not wait for it to finish.
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

  // The main window can be closed while recording, as the app lives in the tray.
  // But the floating panel stays on screen and its timer must not freeze, so the
  // state is sent while there is a recording, not while there is a window.
  setInterval(() => {
    if (session) broadcastState()
  }, 1000).unref?.()
}

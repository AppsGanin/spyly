import { setLang, t } from '@spyly/core'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Notification, app, desktopCapturer, nativeTheme, protocol, session, shell } from 'electron'
import { isRecordingNow, registerIpc, toggleRecordingFromShortcut } from './ipc/handlers.js'
import { loadSettings } from './store/settings.js'
import { mixTracks } from './audio/wav.js'
import { audioFile, setStorageRoot } from './store/paths.js'
import { findBinary } from './binaries.js'
import { usesRendererCapture } from './audio/renderer-capture.js'
import { hideOverlay, overlayWindow, showOverlay } from './overlay.js'
import { killOrphanServers, stopWhisperServer } from './pipeline/whisper-server.js'
import { startUpdates, stopUpdates } from './updates.js'
import { startReminders, stopReminders } from './reminders.js'
import { stopWatchingMeetings, watchMeetings } from './store/watch.js'
import { createTray, destroyTray } from './tray.js'
import { stopCallDetector } from './detect/calls.js'
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './shortcuts.js'
import { recoverOrphanedRecordings } from './recorder/recovery.js'
import { runSelfTest, selfTestArgs } from './selftest.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * An unhandled error in the main process brings the whole application down by
 * default, along with the recording in progress. Losing a recording over a
 * failure in, say, a model download is not acceptable, so it is logged and we
 * carry on.
 */
process.on('uncaughtException', (error) => {
  process.stderr.write(`[unhandled error] ${error.stack ?? error.message}\n`)
  send('toast', { kind: 'error', text: t('Внутренняя ошибка: {error_message}', { error_message: error.message }) })
})

process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  process.stderr.write(`[unhandled rejection] ${text}\n`)
})

// The name is set before the first getPath call: otherwise the data folder is
// named differently in development than in the packaged app, and models get "lost".
app.setName('Spyly')

// The system audio capture flags are set before the app is ready; any later
// and they no longer take effect.
if (process.platform === 'linux') {
  // Without it Chromium on Linux hands over a stream with no audio: the loopback
  // through PulseAudio/PipeWire is off by default.
  app.commandLine.appendSwitch('enable-features', 'PulseaudioLoopbackForScreenShare')
} else if (process.platform === 'darwin') {
  // On macOS 15+ the loopback is behind a separate flag. We do not use it
  // anyway, the audio is taken by our own helper, but without the flag Chromium
  // sometimes hangs the source picker request itself.
  app.commandLine.appendSwitch('enable-features', 'MacSckSystemAudioLoopbackOverride')
}

let mainWindow: BrowserWindow | null = null
/** The application really is being quit, rather than the window just being hidden. */
let quitting = false

export function getMainWindow(): BrowserWindow | null {
  // A destroyed window is an absent window: returning it means putting every
  // caller in front of a check that is easy to forget.
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

/**
 * An event to the renderer.
 *
 * An `isDestroyed()` check is not enough: the window can be closed while
 * recording, and the frame manages to vanish between the check and the send.
 * The recording carries on regardless and must not fail because there is
 * nobody to show it to.
 */
export function send(channel: string, payload: unknown): void {
  // The floating panel gets the same events: it shows the same recording state
  // as the main window.
  for (const window of [mainWindow, overlayWindow()]) {
    if (!window || window.isDestroyed()) continue
    try {
      window.webContents.send(channel, payload)
    } catch {
      // The frame is already destroyed, so there is nothing to lose here.
    }
  }
}

/** The panel comes up for the duration of a recording and goes away with it. */
export function setOverlayVisible(visible: boolean): void {
  if (visible) showOverlay(dirname)
  else hideOverlay()
}

/**
 * The answer to a system audio request from the renderer.
 *
 * Chromium asks what exactly to capture. Showing the user yet another system
 * dialog is unnecessary, they have already picked the source in our own
 * window, so we hand over the whole screen and ask for audio only: the video
 * is switched off straight away.
 *
 * On macOS this path is not used at all; there the audio comes from the native
 * helper.
 */
function registerDisplayMediaHandler(): void {
  if (process.platform === 'darwin') return

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          const screen = sources[0]
          if (!screen) {
            // An empty answer is a refusal; the renderer will see the error and show it.
            callback({})
            return
          }
          callback({ video: screen, audio: 'loopback' })
        })
        .catch((error: unknown) => {
          // Not answering is not an option: without the callback the audio request in
          // the renderer hangs forever, and the recording is eternally "starting".
          process.stderr.write(`[screen sources unavailable] ${String(error)}\n`)
          callback({})
        })
    },
    // Our own audio must not end up in a recording: otherwise listening back to
    // an old recording lands in the new one.
    { useSystemPicker: false }
  )
}

function createWindow(): void {
  // Test runs need to open a window of a given size, to catch layout problems
  // on narrow screens.
  const forced = /^(\d+)x(\d+)$/.exec(process.env.SPYLY_WIN_SIZE ?? '')

  mainWindow = new BrowserWindow({
    width: forced ? Number(forced[1]) : 1180,
    height: forced ? Number(forced[2]) : 780,
    minWidth: 880,
    minHeight: 560,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      preload: path.join(dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // On Windows and Linux the audio is taken by the window itself, and closing
  // it would cut a recording off halfway. So it is hidden rather than closed,
  // and we say so.
  mainWindow.on('close', (event) => {
    if (!usesRendererCapture() || !isRecordingNow() || quitting) return
    event.preventDefault()
    mainWindow?.hide()
    if (Notification.isSupported()) {
      new Notification({
        title: t('Запись продолжается'),
        body: t('Окно свёрнуто в трей — звук пишется дальше. Остановить запись можно из трея.'),
        silent: true
      }).show()
    }
  })

  // Renderer errors are invisible otherwise: DevTools cannot be opened during a test run.
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      process.stderr.write(`[renderer:${event.level}] ${event.message}\n`)
    }
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    process.stderr.write(`[renderer crashed] ${details.reason}\n`)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, description) => {
    process.stderr.write(`[load failed] ${code} ${description}\n`)
  })

  // A screenshot of the window for automated appearance checks.
  // Errors in the window are otherwise only visible with the developer tools
  // open, and during a test run there is nobody to open them.
  if (process.env.SPYLY_CONSOLE) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, source) => {
      if (level < 2) return
      process.stderr.write(`[window] ${message} (${source}:${line})\n`)
    })
  }

  const shotPath = process.env.SPYLY_SCREENSHOT
  if (shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // A screenshot with a menu or dialog open: otherwise the pop-up parts of the
        // interface can only be checked by hand.
        // Key presses of the "meta+z" kind: otherwise the shortcuts can only be
        // checked by hand.
        const keys = process.env.SPYLY_SCREENSHOT_KEY
        if (keys) {
          const parts = keys.toLowerCase().split('+')
          const key = parts[parts.length - 1] ?? ''
          await mainWindow!.webContents.executeJavaScript(
            `window.dispatchEvent(new KeyboardEvent('keydown', {
               key: ${JSON.stringify(key)},
               metaKey: ${parts.includes('meta')},
               shiftKey: ${parts.includes('shift')},\n               bubbles: true\n             })), 'pressed ' + ${JSON.stringify(keys)}`
          ).then((result: string) => process.stderr.write(`[screenshot] ${result}\n`)).catch(() => undefined)
          await new Promise((r) => setTimeout(r, 800))
        }

        // Several presses in a row are separated by " ; ": the place in the interface
        // you need is rarely one click away.
        for (const one of (process.env.SPYLY_SCREENSHOT_CLICK ?? '').split(';')) {
          const click = one.trim()
          if (!click) continue
          await mainWindow!.webContents
            .executeJavaScript(
              `(() => {
                 const target = document.querySelector(${JSON.stringify(click)})\n                 if (!target) return 'not found: ' + ${JSON.stringify(click)}\n                 target.dispatchEvent(new MouseEvent('click', { bubbles: true }))\n                 return 'clicked: ' + ${JSON.stringify(click)}
               })()`
            )
            .then((result: string) => process.stderr.write(`[screenshot] ${result}\n`))
            .catch(() => undefined)
          await new Promise((r) => setTimeout(r, 600))
        }
        const image = await mainWindow!.webContents.capturePage()
        const { writeFile } = await import('node:fs/promises')
        await writeFile(shotPath, image.toPNG())
        process.stderr.write(`[screenshot saved] ${shotPath}\n`)

        // The floating panel lives in its own window and does not appear in a shot of the main one.
        const panel = overlayWindow()
        if (panel) {
          const shot = await panel.webContents.capturePage()
          const target = shotPath.replace(/\.png$/, '-overlay.png')
          await writeFile(target, shot.toPNG())
          process.stderr.write(`[panel screenshot] ${target}\n`)
        }
        if (process.env.SPYLY_SCREENSHOT_EXIT) app.exit(0)
      }, Number(process.env.SPYLY_SCREENSHOT_DELAY ?? 1500))
    })
  }

  // External links go to the browser: they have no business inside the application.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Test runs need to open a particular screen without any clicking.
  if (process.env.SPYLY_START_VIEW) {
    mainWindow.webContents.on('did-finish-load', () => {
      const [kind, tab] = (process.env.SPYLY_START_VIEW ?? '').split(':')
      mainWindow?.webContents.send('debug:view', { kind, tab })
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(dirname, '../renderer/index.html'))
  }
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Our own protocol for listening back to recordings.
 *
 * An <audio> tag with `file://` does not play in Electron: the renderer lives
 * on a different origin, and media on the file scheme is blocked. Through our
 * own scheme a recording is served like an ordinary HTTP resource, seeking
 * over Range included.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'spyly-audio', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: false } }
])

function registerAudioProtocol(): void {
  protocol.handle('spyly-audio', async (request) => {
    const url = new URL(request.url)
    const id = url.hostname
    const track = url.pathname.replace(/^\/+/, '').replace(/\.wav$/, '')
    if (!id || !['mic', 'system', 'mix'].includes(track)) {
      return new Response(t('неизвестная дорожка'), { status: 404 })
    }

    // The path is assembled from the identifier ourselves: taking an arbitrary
    // path from the renderer is not allowed, or it becomes a hole for reading any file.
    const file = audioFile(id, track as 'mic' | 'system' | 'mix')
    if (track === 'mix' && !existsSync(file)) {
      try {
        await mixTracks(audioFile(id, 'mic'), audioFile(id, 'system'), file)
      } catch {
        return new Response(t('не удалось свести дорожки'), { status: 500 })
      }
    }
    if (!existsSync(file)) return new Response(t('нет записи'), { status: 404 })

    const size = statSync(file).size
    const range = request.headers.get('range')

    // Without Content-Length and Range support the <audio> tag never learns the
    // duration and shows Infinity, and seeking does not work at all.
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range)
      const start = match?.[1] ? Number(match[1]) : 0
      const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
      }
      const chunk = await readFile(file).then((buf) => buf.subarray(start, end + 1))
      return new Response(new Uint8Array(chunk), {
        status: 206,
        headers: {
          'content-type': 'audio/wav',
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${size}`,
          'accept-ranges': 'bytes'
        }
      })
    }

    const body = await readFile(file)
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': 'audio/wav',
        'content-length': String(size),
        'accept-ranges': 'bytes'
      }
    })
  })
}

// A second instance of the application would write over the same folder and
// fight for the audio device, so it is turned straight back into the window
// already open. Test runs are exempt from this rule: otherwise they quietly
// exit while the user has an ordinary window open.
const isCheckRun =
  process.argv.includes('--selftest') ||
  Boolean(process.env.SPYLY_SCREENSHOT) ||
  Boolean(process.env.SPYLY_CHECK_CALENDAR) ||
  Boolean(process.env.SPYLY_CHECK_ASR) ||
  Boolean(process.env.SPYLY_CHECK_LIVE) ||
  Boolean(process.env.SPYLY_BENCH) ||
  Boolean(process.env.SPYLY_REPROCESS)

if (!isCheckRun && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  void app.whenReady().then(async () => {
    // Transcription servers from earlier runs hold a model in memory, a gigabyte
    // and a half each. If the application was killed or crashed they stay alive,
    // and after a few launches the machine starts to choke while live
    // transcription can no longer keep up.
    // Updates from releases: checked quietly, installed only with consent and
    // never during a recording.
    startUpdates(isRecordingNow)

    void killOrphanServers().then((killed) => {
      if (killed > 0) process.stderr.write(`[cleanup] stale servers removed: ${killed}\n`)
    })

    const settings = await loadSettings()
    // The main process talks to people too: notifications, the tray menu, error
    // messages. The language is set before any of that appears.
    setLang(settings.uiLang)

    // The end-to-end check runs without a window: it is about audio and the pipeline, not the interface.
    const selfTest = selfTestArgs()
    if (selfTest) {
      if (settings.storageDir) setStorageRoot(settings.storageDir)
      const failures = await runSelfTest(selfTest.fixture, selfTest.seconds).catch((error: unknown) => {
        process.stdout.write(`the check failed: ${String(error)}\n`)
        return 1
      })
      app.exit(failures === 0 ? 0 : 1)
      return
    }


    // A one-off transcription run with a particular model on a particular file.
    // Live transcription: run a file as a stream and see how long after something
    // is said the text appears, and what exactly appears.
    // What the list and the search cost once there are many recordings.
    if (process.env.SPYLY_BENCH) {
      const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const pathMod = await import('node:path')
      const { setStorageRoot, meetingsDir } = await import('./store/paths.js')
      const { listMeetings, searchMeetings } = await import('./store/meetings.js')

      const root = await mkdtemp(pathMod.join(tmpdir(), 'spyly-bench-'))
      setStorageRoot(root)
      const count = Number(process.env.SPYLY_BENCH) || 300
      const words = 'squid billing deadlines task release testing server client report meeting'.split(' ')

      for (let i = 0; i < count; i++) {
        const id = `2026-01-${String((i % 28) + 1).padStart(2, '0')}--zapis-${i}--x${i}`
        const dir = pathMod.join(meetingsDir(), id)
        await mkdir(dir, { recursive: true })
        await writeFile(
          pathMod.join(dir, 'meta.json'),
          JSON.stringify({
            id,
            title: `Recording ${i}`,
            startedAt: new Date(Date.UTC(2026, 0, (i % 28) + 1, 10)).toISOString(),
            durationSec: 1800,
            sources: { mic: true, system: true },
            stages: { recording: 'done', transcribing: 'done' }
          })
        )
        // A half-hour conversation is around 400 utterances.
        const utterances = Array.from({ length: 400 }, (_, u) => ({
          id: `u${u}`,
          speakerId: 'system:0',
          track: 'system',
          start: u * 4,
          end: u * 4 + 3.5,
          text: `${words[(i + u) % words.length]} discussion of item ${u} and what to do about it next`,
          words: [],
          provisional: false
        }))
        await writeFile(
          pathMod.join(dir, 'transcript.json'),
          JSON.stringify({ speakers: [], utterances })
        )
      }

      const t1 = Date.now()
      const list = await listMeetings()
      const listMs = Date.now() - t1

      const t2 = Date.now()
      const found = await searchMeetings(process.env.SPYLY_BENCH_QUERY ?? 'billing')
      const searchMs = Date.now() - t2

      process.stdout.write(
        `[load] recordings ${list.length}: list ${listMs} ms, search ${searchMs} ms, found ${found.length}\n`
      )
      setTimeout(() => app.exit(0), 200)
      return
    }

    if (process.env.SPYLY_CHECK_LIVE) {
      const { LiveTranscriber, isLiveModelReady } = await import('./pipeline/live-stream.js')
      const { readWavPcm16 } = await import('./audio/wav.js')
      if (!isLiveModelReady()) {
        process.stdout.write('[live] the model is not downloaded\n')
        setTimeout(() => app.exit(1), 200)
        return
      }
      const wave = await readWavPcm16(process.env.SPYLY_CHECK_LIVE)
      const step = Math.round(wave.sampleRate * 0.32)
      const loadStart = Date.now()
      const live = new LiveTranscriber('system')
      process.stdout.write(`[live] the model loaded in ${Date.now() - loadStart} ms\n`)
      let worst = 0
      let spent = 0
      let updates = 0
      let finals = 0
      for (let at = 0; at < wave.samples.length; at += step) {
        const t0 = Date.now()
        const update = live.push(wave.samples.subarray(at, Math.min(at + step, wave.samples.length)))
        const took = Date.now() - t0
        spent += took
        worst = Math.max(worst, took)
        if (!update) continue
        updates++
        if (update.final) {
          finals++
          process.stdout.write(`[phrase ${update.start.toFixed(1)}-${update.end.toFixed(1)}] ${update.text}\n`)
        } else if (process.env.SPYLY_LIVE_VERBOSE) {
          process.stdout.write(`  …${update.end.toFixed(1)}: ${update.text.slice(-60)}\n`)
        }
      }
      for (const tail of live.finish()) process.stdout.write(`[tail] ${tail.text}\n`)
      const audioSec = wave.samples.length / wave.sampleRate
      process.stdout.write(
        `[live] audio ${audioSec.toFixed(0)} s, compute ${(spent / 1000).toFixed(1)} s ` +
          `(${(spent / 1000 / audioSec).toFixed(2)}x), worst step ${worst} ms, ` +
          `phrases ${finals}, updates ${updates}\n`
      )
      setTimeout(() => app.exit(0), 200)
      return
    }

    if (process.env.SPYLY_CHECK_ASR) {
      const { providerForModel } = await import('./providers/registry.js')
      const model = process.env.SPYLY_ASR_MODEL ?? 'parakeet-tdt-v3'
      const provider = providerForModel(model)
      const state = await provider.ready()
      if (!state.ready) {
        process.stdout.write(`[transcription] ${provider.name} is not ready: ${state.hint}\n`)
        setTimeout(() => app.exit(1), 200)
        return
      }
      process.stdout.write('[transcription] the engine is ready, reading the file\n')
      const started = Date.now()
      const result = await provider.transcribe(process.env.SPYLY_CHECK_ASR, 'system', {
        language: 'ru',
        onProgress: (p) => process.stdout.write(`[transcription] ${(p * 100).toFixed(0)}%\n`)
      })
      const text = result.segments.map((x) => x.text).join(' ')
      process.stdout.write(
        `[transcription] ${provider.name}: ${text.length} characters in ${((Date.now() - started) / 1000).toFixed(1)} s\n` +
          `${text.slice(0, 400)}\n`
      )
      setTimeout(() => app.exit(0), 200)
      return
    }

    // A full reprocessing of one recording, to check the pipeline end to end.
    if (process.env.SPYLY_REPROCESS) {
      const { processMeeting } = await import('./pipeline/run.js')
      const { readMeeting } = await import('./store/meetings.js')
      // From the very beginning by default, but checking the summary on its own is
      // far quicker than waiting for transcription every time.
      const from = (process.env.SPYLY_REPROCESS_FROM ?? 'transcribing') as 'transcribing' | 'summarizing'
      await processMeeting(process.env.SPYLY_REPROCESS, from)
      const meeting = await readMeeting(process.env.SPYLY_REPROCESS)
      process.stdout.write(
        `[reprocess] "${meeting?.title ?? '—'}", sides ${meeting?.speakers.length ?? 0}, ` +
          `utterances ${meeting?.utterances.length ?? 0}\n`
      )
      for (const s of meeting?.speakers ?? []) {
        const own = (meeting?.utterances ?? []).filter((u) => u.speakerId === s.id)
        const seconds = own.reduce((sum, u) => sum + (u.end - u.start), 0)
        process.stdout.write(`[side] ${s.id} ${own.length} utterances, ${seconds.toFixed(0)} s\n`)
      }
      setTimeout(() => app.exit(0), 300)
      return
    }




    // A test run of calendar access: the system shows its own dialog, and from a
    // bare command line it never appears, so the application has to be launched.
    if (process.env.SPYLY_CHECK_CALENDAR) {
      const { requestCalendarAccess, calendarGranted } = await import('./detect/calendar.js')
      const granted = await requestCalendarAccess()
      process.stdout.write(`[calendar] request: ${granted}, state: ${await calendarGranted()}\n`)
      setTimeout(() => app.exit(granted ? 0 : 1), 300)
      return
    }

    if (settings.storageDir) setStorageRoot(settings.storageDir)
    nativeTheme.themeSource = settings.theme

    registerAudioProtocol()
    registerIpc()
    registerDisplayMediaHandler()
    registerGlobalShortcuts(toggleRecordingFromShortcut)
    createWindow()
    createTray()

    // Recordings interrupted by a crash are repaired before the user sees them.
    await recoverOrphanedRecordings()

    // A summary can also be changed by an agent over MCP, and the app should
    // notice that rather than show yesterday's version.
    watchMeetings((id) => send('meetings:changed', { id }))

    // Task deadlines: we remind, otherwise the list has to be visited.
    startReminders()

    // Looking for commands starts a login shell, which is half a second. Done
    // ahead of time in the background, so the Agents tab opens already filled in.
    void findBinary('claude').catch(() => undefined)


    // Test run: start recording straight away, so the state of the interface
    // during a recording can be captured.
    if (process.env.SPYLY_AUTORECORD) {
      const { autoStartForCheck } = await import('./ipc/handlers.js')
      setTimeout(() => void autoStartForCheck(), 1200)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('will-quit', () => {
    stopUpdates()
    stopWatchingMeetings()
    stopReminders()
    hideOverlay()
    // The transcription server holds a model in memory: without this it outlives
    // the application and hangs around until a reboot.
    stopWhisperServer()
  })

  app.on('window-all-closed', () => {
    // On macOS the app lives in the tray: a closed window must not stop a recording.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    destroyTray()
    stopCallDetector()
    unregisterGlobalShortcuts()
  })
}

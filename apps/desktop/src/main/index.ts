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
 * Необработанная ошибка в главном процессе по умолчанию роняет приложение
 * целиком — вместе с идущей записью. Ронять запись из-за сбоя, например, в
 * скачивании модели нельзя, поэтому логируем и живём дальше.
 */
process.on('uncaughtException', (error) => {
  process.stderr.write(`[необработанная ошибка] ${error.stack ?? error.message}\n`)
  send('toast', { kind: 'error', text: t('Внутренняя ошибка: {error_message}', { error_message: error.message }) })
})

process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  process.stderr.write(`[необработанный отказ] ${text}\n`)
})

// Имя задаётся до первого обращения к getPath: иначе в разработке папка данных
// называется по-другому, чем в собранном приложении, и модели «теряются».
app.setName('Spyly')

// Флаги захвата системного звука ставятся до готовности приложения — позже
// они уже не действуют.
if (process.platform === 'linux') {
  // Без него Chromium на Linux отдаёт поток без звука: петля через
  // PulseAudio/PipeWire по умолчанию выключена.
  app.commandLine.appendSwitch('enable-features', 'PulseaudioLoopbackForScreenShare')
} else if (process.platform === 'darwin') {
  // На macOS 15+ петля закрыта отдельным флагом. Мы ей всё равно не
  // пользуемся — звук берёт свой хелпер, — но без флага Chromium иногда
  // подвешивает сам запрос на выбор источника.
  app.commandLine.appendSwitch('enable-features', 'MacSckSystemAudioLoopbackOverride')
}

let mainWindow: BrowserWindow | null = null
/** Приложение действительно закрывают, а не просто прячут окно. */
let quitting = false

export function getMainWindow(): BrowserWindow | null {
  // Уничтоженное окно — это отсутствующее окно: возвращать его значит
  // подставлять каждого вызывающего под проверку, о которой легко забыть.
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

/**
 * Событие в renderer.
 *
 * Проверки `isDestroyed()` мало: окно можно закрыть во время записи, и кадр
 * успевает исчезнуть между проверкой и отправкой. Запись при этом продолжается
 * и не должна падать из-за того, что её некому показывать.
 */
export function send(channel: string, payload: unknown): void {
  // Плавающая панель получает те же события: она показывает то же состояние
  // записи, что и главное окно.
  for (const window of [mainWindow, overlayWindow()]) {
    if (!window || window.isDestroyed()) continue
    try {
      window.webContents.send(channel, payload)
    } catch {
      // Кадр уже уничтожен — терять тут нечего.
    }
  }
}

/** Панель поднимается на время записи и убирается вместе с ней. */
export function setOverlayVisible(visible: boolean): void {
  if (visible) showOverlay(dirname)
  else hideOverlay()
}

/**
 * Ответ на запрос системного звука из renderer.
 *
 * Chromium спрашивает, что именно захватывать. Показывать человеку ещё один
 * системный диалог не нужно — источник он уже выбрал в нашем окне, поэтому
 * отдаём весь экран и просим только звук: видео мы тут же выключаем.
 *
 * На macOS этот путь не используется вовсе — там звук берёт нативный хелпер.
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
            // Пустой ответ — это отказ; renderer увидит ошибку и покажет её.
            callback({})
            return
          }
          callback({ video: screen, audio: 'loopback' })
        })
        .catch((error: unknown) => {
          // Не ответить нельзя: без вызова callback запрос звука в renderer
          // повиснет навсегда, и запись будет вечно «начинается».
          process.stderr.write(`[источники экрана недоступны] ${String(error)}\n`)
          callback({})
        })
    },
    // Свой собственный звук в запись попадать не должен: иначе прослушивание
    // прошлой записи попадёт в новую.
    { useSystemPicker: false }
  )
}

function createWindow(): void {
  // Проверочным прогонам нужно открывать окно заданного размера, чтобы
  // ловить проблемы вёрстки на узких экранах.
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

  // На Windows и Linux звук берёт само окно, и его закрытие оборвало бы
  // запись на середине. Прячем вместо закрытия и говорим об этом.
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

  // Ошибки renderer иначе не видны: DevTools в проверочных прогонах не открыть.
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      process.stderr.write(`[renderer:${event.level}] ${event.message}\n`)
    }
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    process.stderr.write(`[renderer упал] ${details.reason}\n`)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, description) => {
    process.stderr.write(`[загрузка не удалась] ${code} ${description}\n`)
  })

  // Снимок окна для автоматической проверки внешнего вида.
  // Ошибки в окне иначе видно только в открытых инструментах разработчика:
  // в проверочных прогонах их некому открыть.
  if (process.env.SPYLY_CONSOLE) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, source) => {
      if (level < 2) return
      process.stderr.write(`[окно] ${message} (${source}:${line})\n`)
    })
  }

  const shotPath = process.env.SPYLY_SCREENSHOT
  if (shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // Снимок с раскрытым меню или диалогом: иначе всплывающие части
        // интерфейса нечем проверить, кроме как руками.
        // Нажатие клавиш вида «meta+z»: иначе горячие клавиши нечем проверить,
        // кроме как руками.
        const keys = process.env.SPYLY_SCREENSHOT_KEY
        if (keys) {
          const parts = keys.toLowerCase().split('+')
          const key = parts[parts.length - 1] ?? ''
          await mainWindow!.webContents.executeJavaScript(
            `window.dispatchEvent(new KeyboardEvent('keydown', {
               key: ${JSON.stringify(key)},
               metaKey: ${parts.includes('meta')},
               shiftKey: ${parts.includes('shift')},
               bubbles: true
             })), 'нажал ' + ${JSON.stringify(keys)}`
          ).then((result: string) => process.stderr.write(`[снимок] ${result}\n`)).catch(() => undefined)
          await new Promise((r) => setTimeout(r, 800))
        }

        // Несколько нажатий подряд разделяются « ; »: до нужного места в
        // интерфейсе редко удаётся добраться одним кликом.
        for (const one of (process.env.SPYLY_SCREENSHOT_CLICK ?? '').split(';')) {
          const click = one.trim()
          if (!click) continue
          await mainWindow!.webContents
            .executeJavaScript(
              `(() => {
                 const target = document.querySelector(${JSON.stringify(click)})
                 if (!target) return 'не нашёл: ' + ${JSON.stringify(click)}
                 target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                 return 'нажал: ' + ${JSON.stringify(click)}
               })()`
            )
            .then((result: string) => process.stderr.write(`[снимок] ${result}\n`))
            .catch(() => undefined)
          await new Promise((r) => setTimeout(r, 600))
        }
        const image = await mainWindow!.webContents.capturePage()
        const { writeFile } = await import('node:fs/promises')
        await writeFile(shotPath, image.toPNG())
        process.stderr.write(`[снимок сохранён] ${shotPath}\n`)

        // Плавающая панель живёт в своём окне, и в кадр главного не попадает.
        const panel = overlayWindow()
        if (panel) {
          const shot = await panel.webContents.capturePage()
          const target = shotPath.replace(/\.png$/, '-overlay.png')
          await writeFile(target, shot.toPNG())
          process.stderr.write(`[снимок панели] ${target}\n`)
        }
        if (process.env.SPYLY_SCREENSHOT_EXIT) app.exit(0)
      }, Number(process.env.SPYLY_SCREENSHOT_DELAY ?? 1500))
    })
  }

  // Внешние ссылки уходят в браузер: внутри приложения им делать нечего.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Проверочным прогонам нужно открыть конкретный экран без кликов.
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
 * Свой протокол для прослушивания записей.
 *
 * Тег <audio> с `file://` в Electron не играет: renderer живёт на другом
 * источнике, и медиа с файловой схемы блокируется. Через собственную схему
 * запись отдаётся как обычный HTTP-ресурс, включая перемотку по Range.
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

    // Путь собираем сами из идентификатора: принимать произвольный путь из
    // renderer нельзя, иначе это дыра на чтение любого файла.
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

    // Без Content-Length и поддержки Range тег <audio> не узнаёт длительность
    // и показывает Infinity, а перемотка не работает вовсе.
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

// Второй экземпляр приложения писал бы поверх той же папки и дрался за
// аудиоустройство, поэтому его сразу разворачиваем в уже открытое окно.
// Проверочные прогоны из этого правила выведены: иначе они молча выходят,
// пока у пользователя открыто обычное окно.
const isCheckRun =
  process.argv.includes('--selftest') ||
  Boolean(process.env.SPYLY_SCREENSHOT) ||
  Boolean(process.env.SPYLY_CHECK_CALENDAR) ||
  Boolean(process.env.SPYLY_CHECK_DIARIZE) ||
  Boolean(process.env.SPYLY_CHECK_ASR) ||
  Boolean(process.env.SPYLY_CHECK_LIVE) ||
  Boolean(process.env.SPYLY_BENCH) ||
  Boolean(process.env.SPYLY_CHECK_VOICE) ||
  Boolean(process.env.SPYLY_DIAG_DIAR) ||
  Boolean(process.env.SPYLY_DIAG_VOICEMAP) ||
  Boolean(process.env.SPYLY_REPROCESS)

if (!isCheckRun && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  void app.whenReady().then(async () => {
    // Серверы расшифровки от прошлых запусков держат модель в оперативной
    // памяти — по полтора гигабайта каждый. Если приложение сняли или оно
    // упало, они остаются жить, и через несколько запусков машина начинает
    // задыхаться, а живая расшифровка перестаёт успевать.
    // Обновления из релизов: тихо проверяем, ставим только с согласия и
    // никогда во время записи.
    startUpdates(isRecordingNow)

    void killOrphanServers().then((killed) => {
      if (killed > 0) process.stderr.write(`[очистка] снято зависших серверов: ${killed}\n`)
    })

    const settings = await loadSettings()
    // Главный процесс тоже говорит с человеком: уведомления, меню в трее,
    // сообщения об ошибках. Язык задаётся до того, как что-то из этого появится.
    setLang(settings.uiLang)

    // Сквозная проверка идёт без окна: она про звук и конвейер, не про интерфейс.
    const selfTest = selfTestArgs()
    if (selfTest) {
      if (settings.storageDir) setStorageRoot(settings.storageDir)
      const failures = await runSelfTest(selfTest.fixture, selfTest.seconds).catch((error: unknown) => {
        process.stdout.write(`проверка упала: ${String(error)}\n`)
        return 1
      })
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    // Насколько голос в записи похож на сохранённый слепок.
    if (process.env.SPYLY_CHECK_VOICE) {
      const { listVoices } = await import('./store/voices.js')
      const { readMeeting } = await import('./store/meetings.js')
      const { embedSpeaker, readWave } = await import('./providers/diarization/sherpa.js')
      const { cosineSimilarity, VOICE_MATCH_THRESHOLD } = await import('@spyly/core')
      const { audioFile } = await import('./store/paths.js')

      const meeting = await readMeeting(process.env.SPYLY_CHECK_VOICE)
      const profiles = await listVoices()
      process.stdout.write(`[голос] слепков ${profiles.length}, участников ${meeting?.speakers.length ?? 0}, порог ${VOICE_MATCH_THRESHOLD}\n`)

      for (const track of new Set((meeting?.speakers ?? []).map((s) => s.track))) {
        const wave = await readWave(audioFile(meeting!.id, track))
        const turns = meeting!.utterances
          .filter((u) => u.track === track)
          .map((u) => ({ start: u.start, end: u.end, cluster: Number(u.speakerId.split(':')[1] ?? 0) }))
        for (const speaker of meeting!.speakers.filter((s) => s.track === track)) {
          const embedding = embedSpeaker(wave.samples, wave.sampleRate, turns, speaker.cluster)
          if (!embedding) {
            process.stdout.write(`[голос] ${speaker.id}: слепок не посчитался\n`)
            continue
          }
          for (const profile of profiles) {
            const score = cosineSimilarity(embedding, profile.embedding)
            process.stdout.write(`[голос] ${speaker.id} ↔ «${profile.name}»: ${score.toFixed(3)}\n`)
          }
        }
      }
            // Насколько кластеры похожи друг на друга: так видно, не разбило ли
      // разделение одного человека на нескольких.
      const own: { id: string; embedding: number[] }[] = []
      for (const track of new Set((meeting?.speakers ?? []).map((sp) => sp.track))) {
        const file = audioFile(process.env.SPYLY_CHECK_VOICE, track)
        if (!existsSync(file)) continue
        const wave = await readWave(file)
        const turns = (meeting?.utterances ?? [])
          .filter((u) => u.track === track)
          .map((u) => ({ start: u.start, end: u.end, cluster: Number(u.speakerId.split(':')[1] ?? 0) }))
        for (const speaker of (meeting?.speakers ?? []).filter((sp) => sp.track === track)) {
          const embedding = embedSpeaker(wave.samples, wave.sampleRate, turns, speaker.cluster)
          if (embedding) own.push({ id: speaker.id, embedding })
        }
      }
      for (let a = 0; a < own.length; a++) {
        for (let b = a + 1; b < own.length; b++) {
          const score = cosineSimilarity(own[a]!.embedding, own[b]!.embedding)
          process.stdout.write(`[похожесть] ${own[a]!.id} ↔ ${own[b]!.id}: ${score.toFixed(3)}\n`)
        }
      }
      setTimeout(() => app.exit(0), 200)
      return
    }

    // Разовый прогон расшифровки конкретной моделью на конкретном файле.
    // Живая расшифровка: прогнать файл как поток и посмотреть, через сколько
    // после сказанного появляется текст и что именно появляется.
    // Сколько стоят список и поиск, когда записей становится много.
    if (process.env.SPYLY_BENCH) {
      const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const pathMod = await import('node:path')
      const { setStorageRoot, meetingsDir } = await import('./store/paths.js')
      const { listMeetings, searchMeetings } = await import('./store/meetings.js')

      const root = await mkdtemp(pathMod.join(tmpdir(), 'spyly-bench-'))
      setStorageRoot(root)
      const count = Number(process.env.SPYLY_BENCH) || 300
      const words = 'кальмар биллинг сроки задача релиз тестирование сервер клиент отчёт встреча'.split(' ')

      for (let i = 0; i < count; i++) {
        const id = `2026-01-${String((i % 28) + 1).padStart(2, '0')}--zapis-${i}--x${i}`
        const dir = pathMod.join(meetingsDir(), id)
        await mkdir(dir, { recursive: true })
        await writeFile(
          pathMod.join(dir, 'meta.json'),
          JSON.stringify({
            id,
            title: `Запись ${i}`,
            startedAt: new Date(Date.UTC(2026, 0, (i % 28) + 1, 10)).toISOString(),
            durationSec: 1800,
            sources: { mic: true, system: true },
            stages: { recording: 'done', transcribing: 'done' }
          })
        )
        // Получасовой разговор — около 400 реплик.
        const utterances = Array.from({ length: 400 }, (_, u) => ({
          id: `u${u}`,
          speakerId: 'system:0',
          track: 'system',
          start: u * 4,
          end: u * 4 + 3.5,
          text: `${words[(i + u) % words.length]} обсуждение пункта ${u} и что с ним делать дальше`,
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
      const found = await searchMeetings(process.env.SPYLY_BENCH_QUERY ?? 'биллинг')
      const searchMs = Date.now() - t2

      process.stdout.write(
        `[нагрузка] записей ${list.length}: список ${listMs} мс, поиск ${searchMs} мс, нашлось ${found.length}\n`
      )
      setTimeout(() => app.exit(0), 200)
      return
    }

    if (process.env.SPYLY_CHECK_LIVE) {
      const { LiveTranscriber, isLiveModelReady } = await import('./pipeline/live-stream.js')
      const { readWavPcm16 } = await import('./audio/wav.js')
      if (!isLiveModelReady()) {
        process.stdout.write('[живой] модель не скачана\n')
        setTimeout(() => app.exit(1), 200)
        return
      }
      const wave = await readWavPcm16(process.env.SPYLY_CHECK_LIVE)
      const step = Math.round(wave.sampleRate * 0.32)
      const loadStart = Date.now()
      const live = new LiveTranscriber('system')
      process.stdout.write(`[живой] модель загрузилась за ${Date.now() - loadStart} мс\n`)
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
          process.stdout.write(`[фраза ${update.start.toFixed(1)}-${update.end.toFixed(1)}] ${update.text}\n`)
        } else if (process.env.SPYLY_LIVE_VERBOSE) {
          process.stdout.write(`  …${update.end.toFixed(1)}: ${update.text.slice(-60)}\n`)
        }
      }
      for (const tail of live.finish()) process.stdout.write(`[хвост] ${tail.text}\n`)
      const audioSec = wave.samples.length / wave.sampleRate
      process.stdout.write(
        `[живой] звука ${audioSec.toFixed(0)} с, счёта ${(spent / 1000).toFixed(1)} с ` +
          `(${(spent / 1000 / audioSec).toFixed(2)}x), худший шаг ${worst} мс, ` +
          `фраз ${finals}, обновлений ${updates}\n`
      )
      setTimeout(() => app.exit(0), 200)
      return
    }

    if (process.env.SPYLY_CHECK_ASR) {
      const { providerForModel } = await import('./providers/registry.js')
      const model = process.env.SPYLY_ASR_MODEL ?? 'gigaam-v3-ru'
      const provider = providerForModel(model)
      const state = await provider.ready()
      if (!state.ready) {
        process.stdout.write(`[расшифровка] ${provider.name} не готов: ${state.hint}\n`)
        setTimeout(() => app.exit(1), 200)
        return
      }
      process.stdout.write('[расшифровка] движок готов, читаю файл\n')
      const started = Date.now()
      const result = await provider.transcribe(process.env.SPYLY_CHECK_ASR, 'system', {
        language: 'ru',
        onProgress: (p) => process.stdout.write(`[расшифровка] ${(p * 100).toFixed(0)}%\n`)
      })
      const text = result.segments.map((x) => x.text).join(' ')
      process.stdout.write(
        `[расшифровка] ${provider.name}: ${text.length} символов за ${((Date.now() - started) / 1000).toFixed(1)} с\n` +
          `${text.slice(0, 400)}\n`
      )
      setTimeout(() => app.exit(0), 200)
      return
    }

    // Полная переобработка одной записи — чтобы проверить конвейер целиком.
    if (process.env.SPYLY_REPROCESS) {
      const { processMeeting } = await import('./pipeline/run.js')
      const { readMeeting } = await import('./store/meetings.js')
      // По умолчанию с самого начала, но проверять конспект или разделение
      // по голосам отдельно куда быстрее, чем каждый раз ждать расшифровку.
      const from = (process.env.SPYLY_REPROCESS_FROM ?? 'transcribing') as
        | 'transcribing'
        | 'diarizing'
        | 'summarizing'
      await processMeeting(process.env.SPYLY_REPROCESS, from)
      const meeting = await readMeeting(process.env.SPYLY_REPROCESS)
      process.stdout.write(
        `[переобработка] «${meeting?.title ?? '—'}», участников ${meeting?.speakers.length ?? 0}, ` +
          `реплик ${meeting?.utterances.length ?? 0}\n`
      )
      for (const s of meeting?.speakers ?? []) {
        const own = (meeting?.utterances ?? []).filter((u) => u.speakerId === s.id)
        const seconds = own.reduce((sum, u) => sum + (u.end - u.start), 0)
        process.stdout.write(`[участник] ${s.id} «${s.name ?? '—'}» ${own.length} реплик, ${seconds.toFixed(0)} с\n`)
      }
      setTimeout(() => app.exit(0), 300)
      return
    }

    // Как меняется голос по ходу дорожки: окна по десять секунд и попарная
    // похожесть. Отвечает на вопрос «это один человек или разные».
    if (process.env.SPYLY_DIAG_VOICEMAP) {
      const { embedSpeaker, readWave } = await import('./providers/diarization/sherpa.js')
      const { cosineSimilarity } = await import('@spyly/core')
      const wave = await readWave(process.env.SPYLY_DIAG_VOICEMAP)
      const step = Number(process.env.SPYLY_DIAG_WINDOW ?? 10)
      const total = wave.samples.length / wave.sampleRate

      const windows: { at: number; embedding: number[] }[] = []
      for (let at = 0; at + step <= total; at += step) {
        const turns = [{ start: at, end: at + step, cluster: 0 }]
        const embedding = embedSpeaker(wave.samples, wave.sampleRate, turns, 0, step)
        if (embedding) windows.push({ at, embedding })
      }

      process.stdout.write(`[карта голоса] окон ${windows.length} по ${step} с\n`)
      process.stdout.write('        ' + windows.map((w) => String(w.at).padStart(5)).join('') + '\n')
      for (const a of windows) {
        const row = windows.map((b) =>
          (a === b ? '    ·' : cosineSimilarity(a.embedding, b.embedding).toFixed(2).padStart(5))
        )
        process.stdout.write(String(a.at).padStart(6) + '  ' + row.join('') + '\n')
      }
      setTimeout(() => app.exit(0), 200)
      return
    }

    // Что именно возвращает разделение по голосам: отрезки с временами.
    if (process.env.SPYLY_DIAG_DIAR) {
      const { sherpa, segmentationModelPath, embeddingModelPath } = await import(
        './providers/diarization/sherpa.js'
      )
      const { readWavPcm16 } = await import('./audio/wav.js')
      const { OfflineSpeakerDiarization } = sherpa()
      const wave = await readWavPcm16(process.env.SPYLY_DIAG_DIAR)
      const engine = new OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: segmentationModelPath() }, numThreads: 4 },
        embedding: { model: embeddingModelPath(), numThreads: 4 },
        clustering: { numClusters: Number(process.env.SPYLY_DIAG_N ?? -1), threshold: 0.9 },
        minDurationOn: 0.3,
        minDurationOff: 0.5
      })
      process.stdout.write(
        `[диагностика] модель ждёт ${engine.sampleRate} Гц, файл ${wave.sampleRate} Гц, ` +
          `длина ${(wave.samples.length / wave.sampleRate).toFixed(0)} с\n`
      )
      const turns = engine.process(wave.samples)
      for (const t of turns) {
        process.stdout.write(
          `[отрезок] ${t.start.toFixed(1)}–${t.end.toFixed(1)} (${(t.end - t.start).toFixed(1)} с) → говорящий ${t.speaker}\n`
        )
      }
      setTimeout(() => app.exit(0), 200)
      return
    }

    // Разовый замер разделения по голосам на конкретном файле.
    if (process.env.SPYLY_CHECK_DIARIZE) {
      const { getDiarizationProvider } = await import('./providers/registry.js')
      const provider = getDiarizationProvider('sherpa-onnx')
      const thresholds = (process.env.SPYLY_THRESHOLDS ?? '0.8')
        .split(',')
        .map(Number)
        .filter((v) => Number.isFinite(v))
      for (const threshold of thresholds) {
        const started = Date.now()
        const turns = (await provider?.diarize(process.env.SPYLY_CHECK_DIARIZE, { threshold })) ?? []
        const clusters = new Set(turns.map((t) => t.cluster))
        const longest = turns.reduce((max, t) => Math.max(max, t.end - t.start), 0)
        process.stdout.write(
          `[диаризация] порог ${threshold}: отрезков ${turns.length}, кластеров ${clusters.size}, ` +
            `самый длинный ${longest.toFixed(0)} с, за ${((Date.now() - started) / 1000).toFixed(1)} с\n`
        )
      }
      setTimeout(() => app.exit(0), 200)
      return
    }

    // Проверочный прогон доступа к календарю: своё окно показывает система, и
    // из голой командной строки оно не появляется — нужен запуск приложения.
    if (process.env.SPYLY_CHECK_CALENDAR) {
      const { requestCalendarAccess, calendarGranted } = await import('./detect/calendar.js')
      const granted = await requestCalendarAccess()
      process.stdout.write(`[календарь] запрос: ${granted}, состояние: ${await calendarGranted()}\n`)
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

    // Записи, прерванные падением, чинятся до того, как пользователь их увидит.
    await recoverOrphanedRecordings()

    // Конспект может поменять и агент через MCP — приложение должно это
    // заметить, а не показывать вчерашнее.
    watchMeetings((id) => send('meetings:changed', { id }))

    // Сроки задач: напоминаем сами, иначе за списком надо ходить.
    startReminders()

    // Поиск команд поднимает оболочку входа — это полсекунды. Делаем это
    // заранее и в фоне, чтобы вкладка «Агенты» открывалась уже заполненной.
    void findBinary('claude').catch(() => undefined)


    // Проверочный прогон: начать запись сразу, чтобы можно было снять
    // состояние интерфейса во время записи.
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
    // Сервер расшифровки держит модель в памяти: без этого он переживает
    // приложение и остаётся висеть до перезагрузки.
    stopWhisperServer()
  })

  app.on('window-all-closed', () => {
    // На macOS приложение живёт в трее: закрытое окно не должно останавливать запись.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    destroyTray()
    stopCallDetector()
    unregisterGlobalShortcuts()
  })
}

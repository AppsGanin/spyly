import { EventEmitter } from 'node:events'
import { lang, t, MeetingMeta } from '@spyly/core'
import type { RecordingState, StartRecordingOptions } from '../../shared/ipc.js'
import { NativeCapture, SAMPLE_RATE } from '../audio/native.js'
import { RendererCapture, usesRendererCapture } from '../audio/renderer-capture.js'
import { WavWriter } from '../audio/wav.js'
import { audioFile, ensureMeetingDirs, makeMeetingId, storageRoot } from '../store/paths.js'
import { writeMeta } from '../store/meetings.js'

/**
 * Запас места, ниже которого запись не начинаем.
 *
 * Дорожка занимает около 2 МБ в час, но кончившееся место посреди разговора —
 * это потерянная встреча, а не мелкая неприятность.
 */
const MIN_FREE_BYTES = 500 * 1024 * 1024

async function ensureFreeSpace(): Promise<void> {
  const { statfs } = await import('node:fs/promises')
  try {
    const stats = await statfs(storageRoot())
    const free = stats.bavail * stats.bsize
    if (free < MIN_FREE_BYTES) {
      throw new Error(`на диске осталось ${Math.round(free / 1e6)} МБ — этого мало для записи`)
    }
  } catch (error) {
    // Если сама проверка не удалась, запись важнее: не мешаем.
    if (error instanceof Error && error.message.includes('осталось')) throw error
  }
}

/** Насколько дорожка может отстать от часов, прежде чем добьём тишиной. */
/**
 * Сколько ждать первого звука от источника.
 *
 * Меньше — ложные тревоги на паузе в начале разговора; больше — человек успеет
 * наговорить минуту в мёртвый микрофон.
 */
const SILENT_SOURCE_TIMEOUT_MS = 5000

const DRIFT_TOLERANCE_SEC = 0.15
const DRIFT_CHECK_MS = 1000

/** Оба способа захвата дают одно и то же: события и уровень. */
type Capture = NativeCapture | RendererCapture

interface Track {
  id: 'mic' | 'system'
  capture: Capture
  writer: WavWriter
  ready: boolean
  error: string | null
  /** Пришёл ли хоть один сэмпл: «готов» ещё не значит «работает». */
  gotAudio: boolean
}

/**
 * Одна сессия записи.
 *
 * Дорожки пишутся раздельно и никогда не микшируются: это даёт разделение
 * «комната / удалённые» бесплатно, убирает эхо и позволяет диаризовать каждую
 * дорожку независимо.
 */
export class RecordingSession extends EventEmitter {
  private tracks: Track[] = []
  private driftTimer: NodeJS.Timeout | null = null
  private startedAtMs = 0
  /** Суммарное время на паузе — вычитается из общей длительности. */
  private pausedMs = 0
  private pauseStartedAt: number | null = null
  private status: RecordingState['status'] = 'idle'
  private error: string | null = null
  /** Все дорожки заведены: только после этого их потеря что-то значит. */
  private allTracksStarted = false

  readonly meetingId: string
  readonly meta: MeetingMeta
  /** Отметки важных мест, поставленные во время записи. */
  private readonly marks: { id: string; at: number; note: string }[] = []

  /** Сколько уже записано раньше — при продолжении отсчёт идёт от этого. */
  private offsetSec = 0

  constructor(
    private readonly options: StartRecordingOptions,
    appPids: number[],
    /** Продолжаемая встреча: её мета и уже записанная длительность. */
    previous?: { meta: MeetingMeta; durationSec: number }
  ) {
    super()
    const now = new Date()
    if (previous) {
      // Продолжение: идентификатор, название и отметки остаются прежними.
      this.meetingId = previous.meta.id
      this.offsetSec = previous.durationSec
      this.marks.push(...previous.meta.marks)
      this.meta = { ...previous.meta, stages: { ...previous.meta.stages, recording: 'running' } }
      this.appPids = appPids
      return
    }

    const given = options.title?.trim()
    const title = given || defaultTitle(now)
    this.meetingId = makeMeetingId(title, now)
    this.meta = MeetingMeta.parse({
      id: this.meetingId,
      title,
      titleAuto: !given,
      startedAt: now.toISOString(),
      language: 'ru',
      sources: {
        mic: options.mic,
        system: options.system,
        systemScope: options.systemApps?.length ? options.systemApps.join(', ') : undefined
      },
      calendarEventId: options.calendarEventId,
      calendarParticipants: options.calendarParticipants ?? [],
      stages: { recording: 'running' }
    })
    this.appPids = appPids
  }

  private appPids: number[] = []

  /** Сколько всего записано с учётом прошлых частей. */
  totalSec(): number {
    return this.offsetSec + this.elapsedSec()
  }

  async start(): Promise<void> {
    this.status = 'starting'
    await ensureFreeSpace()
    await ensureMeetingDirs(this.meetingId)
    await writeMeta(this.meta)

    // На macOS звук берёт свой хелпер поверх CoreAudio, на остальных
    // платформах — сам Chromium: там его loopback работает штатно.
    const viaRenderer = usesRendererCapture()

    if (this.options.mic) {
      await this.addTrack(
        'mic',
        viaRenderer
          ? new RendererCapture({ source: 'mic', micDeviceId: this.options.micDeviceId })
          : new NativeCapture({ source: 'mic', micDeviceId: this.options.micDeviceId })
      )
    }
    if (this.options.system) {
      await this.addTrack(
        'system',
        viaRenderer
          ? new RendererCapture({ source: 'system' })
          : new NativeCapture({
              source: 'system',
              includePids: this.appPids.length ? this.appPids : undefined,
              // Свой собственный звук в запись попадать не должен — иначе
              // воспроизведение прошлой встречи попадёт в новую.
              excludePids: this.appPids.length ? undefined : [process.pid]
            })
      )
    }

    if (this.tracks.length === 0) {
      throw new Error(t('не выбрано ни одного источника звука'))
    }

    this.allTracksStarted = true
    this.startedAtMs = Date.now()
    this.status = 'recording'

    /*
     * Проверка, что источник и правда звучит.
     *
     * «Готов» — это ещё не «работает»: микрофон iPhone по Continuity, например,
     * открывается без ошибок и не отдаёт ни одного сэмпла. Дальше выравнивание
     * дорожек прилежно дописывает тишину, и человек узнаёт о пустой записи
     * только когда разговор закончился.
     */
    setTimeout(() => {
      if (this.status !== 'recording') return
      for (const track of this.tracks) {
        if (track.gotAudio || track.error) continue
        track.error = t('источник не отдаёт звук')
        this.error =
          track.id === 'mic'
            ? t('Микрофон не отдаёт звук — выберите другой в списке источников')
            : t('Системный звук не поступает — проверьте, что выбрано нужное приложение')
        this.emitState()
      }
    }, SILENT_SOURCE_TIMEOUT_MS).unref?.()
    this.driftTimer = setInterval(() => this.compensateDrift(), DRIFT_CHECK_MS)
    this.driftTimer.unref?.()
    this.emitState()
  }

  private async addTrack(id: 'mic' | 'system', capture: Capture): Promise<void> {
    const writer = new WavWriter({
      path: audioFile(this.meetingId, id),
      sampleRate: SAMPLE_RATE,
      channels: 1,
      append: this.offsetSec > 0
    })
    await writer.open()
    const track: Track = { id, capture, writer, ready: false, error: null, gotAudio: false }

    capture.on('samples', (chunk: Float32Array) => {
      track.gotAudio = true
      if (this.status === 'paused') return
      writer.writeFloat32(chunk)
      this.emit('samples', id, chunk)
    })
    capture.on('ready', () => {
      track.ready = true
      this.emitState()
    })
    capture.on('level', () => this.emit('levels', this.levels()))
    capture.on('error', (message: string) => {
      track.error = message
      this.error = `${id === 'mic' ? t('микрофон') : t('системный звук')}: ${message}`
      // Захват через окно не «завершается» — он просто не открывается, и без
      // этой проверки запись писала бы тишину до самого конца разговора.
      // Ждём, пока встанут все дорожки: иначе ошибка первой, пришедшая раньше,
      // чем открылась вторая, выглядела бы как потеря всех.
      if (this.allTracksStarted && this.tracks.every((t) => t.error !== null)) {
        this.emit('allTracksLost')
      }
      this.emitState()
    })
    capture.on('exit', (code: number | null) => {
      if (this.status !== 'recording' && this.status !== 'paused') return
      track.error = t('захват прервался (код {code})', { code: code ?? '?' })
      this.error = `${id === 'mic' ? t('микрофон') : t('системный звук')}: ${track.error}`
      // Если замолчали все источники, продолжать бессмысленно: дальше пишется
      // одна тишина, и пользователь узнает об этом только в конце.
      if (this.tracks.every((t) => t.error !== null)) this.emit('allTracksLost')
      this.emitState()
    })

    capture.start()
    this.tracks.push(track)
  }

  /**
   * Догнать часы тишиной.
   *
   * CoreAudio не вызывает колбэк, пока выбранное приложение молчит: за час
   * созвона дорожка микрофона и дорожка системного звука разъедутся на минуты,
   * и все таймкоды в расшифровке поедут. Поэтому недостающее дописываем сами.
   */
  private compensateDrift(): void {
    if (this.status !== 'recording') return
    const expected = this.totalSec()
    for (const track of this.tracks) {
      const behind = expected - track.writer.durationSec
      if (behind > DRIFT_TOLERANCE_SEC) track.writer.writeSilence(behind)
    }
  }

  elapsedSec(): number {
    if (!this.startedAtMs) return 0
    const pausedNow = this.pauseStartedAt ? Date.now() - this.pauseStartedAt : 0
    return Math.max(0, (Date.now() - this.startedAtMs - this.pausedMs - pausedNow) / 1000)
  }

  levels(): { mic: number; system: number } {
    const find = (id: 'mic' | 'system') => this.tracks.find((t) => t.id === id)?.capture.level ?? 0
    return { mic: find('mic'), system: find('system') }
  }

  /**
   * Отметить текущую секунду как важную.
   *
   * Записываем позицию в записи, а не время суток: после паузы они
   * расходятся, а по расшифровке ориентируются именно по позиции.
   */
  mark(note = ''): { id: string; at: number } | null {
    if (this.status !== 'recording' && this.status !== 'paused') return null
    // Отметка ставится в общей шкале записи: при продолжении это важно,
    // иначе новая часть перезапишет таймкоды старой.
    const at = this.totalSec()
    const id = `mark-${this.marks.length + 1}`
    this.marks.push({ id, at, note })
    return { id, at }
  }

  /** Пояснение пишется после нажатия: в момент отметки печатать некогда. */
  annotate(id: string, note: string): void {
    const mark = this.marks.find((m) => m.id === id)
    if (mark) mark.note = note.trim()
  }

  currentMarks(): { id: string; at: number; note: string }[] {
    return [...this.marks]
  }

  pause(): void {
    if (this.status !== 'recording') return
    this.status = 'paused'
    this.pauseStartedAt = Date.now()
    this.emitState()
  }

  resume(): void {
    if (this.status !== 'paused') return
    if (this.pauseStartedAt) this.pausedMs += Date.now() - this.pauseStartedAt
    this.pauseStartedAt = null
    this.status = 'recording'
    this.emitState()
  }

  async stop(): Promise<{ durationSec: number }> {
    if (this.status === 'stopping' || this.status === 'idle') return { durationSec: 0 }
    this.status = 'stopping'
    // Живой расшифровке нужно отдать хвост последней фразы до того,
    // как захват остановится.
    this.emit('stopping')
    this.emitState()

    if (this.driftTimer) clearInterval(this.driftTimer)
    this.compensateDrift()

    for (const track of this.tracks) track.capture.stop()
    // Хелпер может дослать буфер уже после SIGTERM.
    await new Promise((r) => setTimeout(r, 250))
    for (const track of this.tracks) await track.writer.close()

    const durationSec = Math.max(this.offsetSec, ...this.tracks.map((t) => t.writer.durationSec))
    this.status = 'idle'
    this.emitState()
    return { durationSec }
  }

  state(): RecordingState {
    return {
      status: this.status,
      meetingId: this.meetingId,
      startedAt: this.startedAtMs || null,
      elapsedSec: this.elapsedSec(),
      levels: this.levels(),
      tracks: {
        mic: this.tracks.some((t) => t.id === 'mic'),
        system: this.tracks.some((t) => t.id === 'system')
      },
      error: this.error
    }
  }

  private emitState(): void {
    this.emit('state', this.state())
  }
}

export function idleState(): RecordingState {
  return {
    status: 'idle',
    meetingId: null,
    startedAt: null,
    elapsedSec: 0,
    levels: { mic: 0, system: 0 },
    tracks: { mic: false, system: false },
    error: null
  }
}

function defaultTitle(when: Date): string {
  const locale = lang() === 'en' ? 'en-US' : 'ru-RU'
  const time = when.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const date = when.toLocaleDateString(locale, { day: 'numeric', month: 'long' })
  return t('Запись {date}, {time}', { date, time })
}

import { EventEmitter } from 'node:events'
import { lang, t, MeetingMeta } from '@spyly/core'
import type { RecordingState, StartRecordingOptions } from '../../shared/ipc.js'
import { NativeCapture, SAMPLE_RATE } from '../audio/native.js'
import { RendererCapture, usesRendererCapture } from '../audio/renderer-capture.js'
import { WavWriter } from '../audio/wav.js'
import { audioFile, ensureMeetingDirs, makeMeetingId, storageRoot } from '../store/paths.js'
import { writeMeta } from '../store/meetings.js'

/**
 * The free space below which a recording is not started.
 *
 * A track takes around 2 MB an hour, but running out of space mid-conversation
 * is a meeting lost, not a minor annoyance.
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
    // If the check itself failed, the recording matters more: we do not get in the way.
    if (error instanceof Error && error.message.includes('осталось')) throw error
  }
}

/** How far a track may fall behind the clock before we fill it in with silence. */
/**
 * How long to wait for the first audio from a source.
 *
 * Less, and a pause at the start of a conversation raises a false alarm; more,
 * and a person gets to talk for a minute into a dead microphone.
 */
const SILENT_SOURCE_TIMEOUT_MS = 5000

const DRIFT_TOLERANCE_SEC = 0.15
const DRIFT_CHECK_MS = 1000

/** Both ways of capturing give the same thing: events and a level. */
type Capture = NativeCapture | RendererCapture

interface Track {
  id: 'mic' | 'system'
  capture: Capture
  writer: WavWriter
  ready: boolean
  error: string | null
  /** Whether a single sample has arrived: "ready" does not yet mean "working". */
  gotAudio: boolean
}

/**
 * One recording session.
 *
 * The tracks are written separately and never mixed: that gives the "room
 * versus remote" split for free, removes echo and lets each track be diarized
 * independently.
 */
export class RecordingSession extends EventEmitter {
  private tracks: Track[] = []
  private driftTimer: NodeJS.Timeout | null = null
  private startedAtMs = 0
  /** Total time spent paused, subtracted from the overall duration. */
  private pausedMs = 0
  private pauseStartedAt: number | null = null
  private status: RecordingState['status'] = 'idle'
  private error: string | null = null
  /** Every track is up: only after that does losing one mean anything. */
  private allTracksStarted = false

  readonly meetingId: string
  readonly meta: MeetingMeta
  /** Marks on important moments, placed during the recording. */
  private readonly marks: { id: string; at: number; note: string }[] = []

  /** How much has already been recorded before: when continuing, the count starts from this. */
  private offsetSec = 0

  constructor(
    private readonly options: StartRecordingOptions,
    appPids: number[],
    /** The meeting being continued: its meta and the duration already recorded. */
    previous?: { meta: MeetingMeta; durationSec: number }
  ) {
    super()
    const now = new Date()
    if (previous) {
      // Continuing: the identifier, the title and the marks stay as they were.
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

  /** How much has been recorded in total, earlier parts included. */
  totalSec(): number {
    return this.offsetSec + this.elapsedSec()
  }

  async start(): Promise<void> {
    this.status = 'starting'
    await ensureFreeSpace()
    await ensureMeetingDirs(this.meetingId)
    await writeMeta(this.meta)

    // On macOS the audio is taken by our own helper on top of CoreAudio, on the
    // other platforms by Chromium itself: its loopback works properly there.
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
              // Our own audio must not end up in a recording, or playing back an earlier
              // meeting lands in the new one.
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
     * A check that the source really is making sound.
     *
     * "Ready" is not yet "working": an iPhone microphone over Continuity, for
     * instance, opens without an error and hands over not a single sample. Track
     * alignment then diligently fills in silence, and a person finds out the
     * recording was empty only once the conversation is over.
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
      // Capture through the window does not "end", it simply never opens, and
      // without this check a recording would write silence until the conversation was over.
      // We wait for every track to come up: otherwise an error on the first,
      // arriving before the second had opened, would look like losing them all.
      if (this.allTracksStarted && this.tracks.every((t) => t.error !== null)) {
        this.emit('allTracksLost')
      }
      this.emitState()
    })
    capture.on('exit', (code: number | null) => {
      if (this.status !== 'recording' && this.status !== 'paused') return
      track.error = t('захват прервался (код {code})', { code: code ?? '?' })
      this.error = `${id === 'mic' ? t('микрофон') : t('системный звук')}: ${track.error}`
      // If every source has gone quiet there is no point carrying on: from here it
      // is silence being written, and the user would find out only at the end.
      if (this.tracks.every((t) => t.error !== null)) this.emit('allTracksLost')
      this.emitState()
    })

    capture.start()
    this.tracks.push(track)
  }

  /**
   * Catch up with the clock using silence.
   *
   * CoreAudio does not call the callback while the chosen application is silent:
   * over an hour-long call the microphone track and the system audio track drift
   * apart by minutes, and every timestamp in the transcript shifts. So the
   * missing part is written in here.
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
   * Mark the current second as important.
   *
   * The position in the recording is stored rather than the time of day: after a
   * pause the two diverge, and a transcript is navigated by position.
   */
  mark(note = ''): { id: string; at: number } | null {
    if (this.status !== 'recording' && this.status !== 'paused') return null
    // The mark is placed on the recording's overall scale: that matters when
    // continuing, or the new part would overwrite the timestamps of the old one.
    const at = this.totalSec()
    const id = `mark-${this.marks.length + 1}`
    this.marks.push({ id, at, note })
    return { id, at }
  }

  /** The note is written after the key press: at the moment of marking there is no time to type. */
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
    // Live transcription needs the tail of the last phrase handed over before
    // capture stops.
    this.emit('stopping')
    this.emitState()

    if (this.driftTimer) clearInterval(this.driftTimer)
    this.compensateDrift()

    for (const track of this.tracks) track.capture.stop()
    // The helper may send a buffer along even after SIGTERM.
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

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

/**
 * Not enough room on the disk.
 *
 * A class of its own rather than a match on the message text: the message is
 * translated, and matching on it stopped telling our own failure apart from a
 * statfs failure the moment the interface was switched to another language.
 */
class NotEnoughSpace extends Error {}

async function ensureFreeSpace(): Promise<void> {
  const { statfs } = await import('node:fs/promises')
  try {
    const stats = await statfs(storageRoot())
    const free = stats.bavail * stats.bsize
    if (free < MIN_FREE_BYTES) {
      throw new NotEnoughSpace(t('на диске осталось {mb} МБ — этого мало для записи', { mb: Math.round(free / 1e6) }))
    }
  } catch (error) {
    // If the check itself failed, the recording matters more: we do not get in the way.
    if (error instanceof NotEnoughSpace) throw error
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

/**
 * How long a source may hand over nothing but digital silence.
 *
 * Longer than the wait for the first sample: a person may well start the
 * recording and stay quiet for a few seconds. But not much longer — the point
 * of the check is that they find out now rather than after the conversation.
 */
const DEAD_SOURCE_TIMEOUT_MS = 12_000

/**
 * Below this a sample counts as digital silence.
 *
 * Not "a quiet room": a live microphone always has a noise floor well above
 * this, and even a good one sits around -70 dBFS. Exactly zero comes from a
 * source that is not working — a muted input, a device taken by another
 * application, a phone microphone over Continuity that opened and gave nothing.
 */
const SILENCE_FLOOR = 1e-4

/**
 * How long the microphone may hand over silence before it is restarted.
 *
 * Shorter than the final verdict: a second attempt lies ahead, and waiting the
 * full time twice would cost half a minute of the conversation.
 */
const MIC_RETRY_TIMEOUT_MS = 6000

/** How often the "hands over silence" check runs. */
const DEAD_SOURCE_CHECK_MS = 3000

/** Whether there is anything in the frame beyond digital silence. */
function hasSound(chunk: Float32Array): boolean {
  for (const sample of chunk) {
    if (sample > SILENCE_FLOOR || sample < -SILENCE_FLOOR) return true
  }
  return false
}

/**
 * How far a track may fall behind the clock before silence is written in.
 *
 * Measured on a real hour-long call: with a tolerance of 0.15 s the system
 * track was padded on almost every check, because a tap hands audio over in
 * bursts and is routinely a fraction of a second late. The burst then landed
 * after the padding, and the same second was counted twice. The tracks came out
 * 1.5 seconds apart, and echo appeared to precede the sound that caused it.
 *
 * So the tolerance is now wider than any normal buffering, and a track has to
 * stay behind for several checks in a row before anything is written: a source
 * that is genuinely silent stays behind, one that is merely late catches up.
 */
const DRIFT_TOLERANCE_SEC = 1.5
const DRIFT_CHECK_MS = 1000
/** How many checks in a row a track must be behind before silence is written. */
const DRIFT_CONFIRMATIONS = 3

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
  /** Whether anything above digital silence has arrived: samples are not yet sound. */
  gotSound: boolean
  /** Reported as dead already, so the message is not rewritten every check. */
  warnedDead: boolean
  /** Already restarted without echo cancellation; there is no second attempt. */
  retriedPlain: boolean
  /** When silence on this track stops being a pause and becomes a fault, in ms since the epoch. */
  judgeAt: number
  /** Consecutive checks this track has been behind the clock. */
  behindChecks: number
  /** Told already that the speakers cannot be removed from the microphone. */
  warnedEcho: boolean
}

/**
 * One recording session.
 *
 * The tracks are written separately and never mixed: that gives the "room
 * versus remote" split for free and removes echo: the microphone is you, the
 * system audio is the other side.
 */
export class RecordingSession extends EventEmitter {
  private tracks: Track[] = []
  private driftTimer: NodeJS.Timeout | null = null
  private deadTimer: NodeJS.Timeout | null = null
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

    /*
     * A source that hands over samples but no sound.
     *
     * The check above catches a source that gives nothing at all. A worse case
     * gives frames of exact zeros: the track is written to the full length, the
     * timer runs, the level meter is calm, and the conversation turns out to be
     * one-sided only once it is over. A muted input or a device taken by another
     * application looks exactly like this.
     */
    this.deadTimer = setInterval(() => {
      if (this.status !== 'recording') return
      for (const track of this.tracks) {
        if (track.gotSound || track.error || track.warnedDead) continue
        if (!track.gotAudio) continue
        if (Date.now() < track.judgeAt) continue

        // The microphone gets a second attempt without echo cancellation before
        // it is declared broken: that is the one thing that turns a working
        // input into a stream of zeros, and it is the difference between this
        // and the level meter in the source picker, which never had it on.
        if (track.id === 'mic' && !track.retriedPlain) {
          track.retriedPlain = true
          track.judgeAt = Date.now() + DEAD_SOURCE_TIMEOUT_MS
          this.restartWithoutEchoCancel(track)
          continue
        }

        track.warnedDead = true
        this.error =
          track.id === 'mic'
            ? t('Микрофон пишет тишину — проверьте, не выключен ли он и не занят ли другим приложением')
            : t('Системный звук пишет тишину — проверьте, что выбрано нужное приложение')
        this.emitState()
      }
    }, DEAD_SOURCE_CHECK_MS)
    this.deadTimer.unref?.()
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
    const track: Track = {
      id, capture, writer, ready: false, error: null,
      gotAudio: false, gotSound: false, warnedDead: false, retriedPlain: false,
      // The microphone is judged sooner: it has a second attempt ahead of it,
      // and waiting the full time twice would cost half a minute of the call.
      judgeAt: Date.now() + (id === 'mic' ? MIC_RETRY_TIMEOUT_MS : DEAD_SOURCE_TIMEOUT_MS),
      behindChecks: 0,
      warnedEcho: false
    }

    this.wireCapture(track, capture)
    capture.start()
    this.tracks.push(track)
  }

  /**
   * Everything a capture reports, hooked up to the track.
   *
   * Kept apart from creating the track so that the capture can be replaced
   * without touching the file being written: the microphone is restarted
   * without echo cancellation when it hands over silence, and the recording
   * carries on into the same WAV.
   */
  private wireCapture(track: Track, capture: Capture): void {
    const id = track.id
    const writer = track.writer

    capture.on('samples', (chunk: Float32Array) => {
      track.gotAudio = true
      if (!track.gotSound && hasSound(chunk)) {
        track.gotSound = true
        // The source came alive after all — take the complaint back rather than
        // leave it hanging over a recording that is now working.
        if (track.warnedDead) {
          track.warnedDead = false
          track.error = null
          this.error = null
          this.emitState()
        }
      }
      if (this.status === 'paused') return
      writer.writeFloat32(chunk)
      this.emit('samples', id, chunk)
    })
    capture.on('ready', () => {
      track.ready = true
      this.emitState()
    })

    /*
     * The system could not take the speakers out of the microphone.
     *
     * It needs the same device for input and output; with an external
     * microphone, or speakers separate from it, the node simply does not start.
     * Recording carries on — echo is better than nothing — but the other side
     * will be audible through the microphone and will land in the transcript
     * twice. That is worth saying while it can still be fixed by putting
     * headphones on, not afterwards.
     */
    capture.on('echoCancel', (on: boolean) => {
      if (id !== 'mic' || on || track.warnedEcho) return
      track.warnedEcho = true
      this.error = t('Эхоподавление недоступно: собеседник будет слышен и через ваш микрофон. Наденьте наушники.')
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
  }

  /**
   * Start the microphone again, this time without echo cancellation.
   *
   * The system node that removes the other side from the microphone is the one
   * thing that turns a working input into exact zeros — with another
   * application holding the microphone for a call, for instance. Echo in the
   * recording is a nuisance; a silent recording is a lost conversation, so the
   * nuisance wins.
   *
   * The writer is not touched: the file goes on, and the gap left while the
   * capture comes back up is filled with silence by the drift compensation.
   */
  private restartWithoutEchoCancel(track: Track): void {
    if (track.id !== 'mic' || usesRendererCapture()) return

    process.stderr.write('[recorder] the microphone is writing silence, restarting without echo cancellation\n')
    track.capture.removeAllListeners()
    track.capture.stop()

    const capture = new NativeCapture({
      source: 'mic',
      micDeviceId: this.options.micDeviceId,
      noEchoCancel: true
    })
    track.capture = capture
    track.ready = false
    track.gotAudio = false
    this.wireCapture(track, capture)
    capture.start()
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
      if (behind <= DRIFT_TOLERANCE_SEC) {
        track.behindChecks = 0
        continue
      }
      track.behindChecks++
      if (track.behindChecks < DRIFT_CONFIRMATIONS) continue

      // Only what the source was behind by when we first noticed: audio that
      // has arrived since then has already taken its place in the file, and
      // padding for it again is what pushed the track out of step.
      track.writer.writeSilence(behind)
      track.behindChecks = 0
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
    if (this.deadTimer) clearInterval(this.deadTimer)
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

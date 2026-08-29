import { t } from '@spyly/core'
import { EventEmitter } from 'node:events'
import { getMainWindow } from '../index.js'

/**
 * Capturing audio through the renderer, the path for Windows and Linux.
 *
 * The interface is the same as for native capture on macOS: a recording
 * session must not know where the audio comes from. The only difference is
 * that PCM arrives over IPC from the window rather than from a child
 * process's stdout.
 *
 * The weak spot of this path is the window: closing it interrupts the
 * capture. So a window closed while recording is not allowed to be destroyed
 * (see main).
 */
export const SAMPLE_RATE = 16000

export interface RendererCaptureOptions {
  source: 'system' | 'mic'
  micDeviceId?: string
}

/** Who is currently waiting for chunks on each track. */
const listeners = new Map<'mic' | 'system', (samples: Float32Array) => void>()

/** Called from the IPC handler when the renderer has sent another chunk. */
export function deliverSamples(track: 'mic' | 'system', samples: Float32Array): void {
  listeners.get(track)?.(samples)
}

/** A capture failure on the renderer side, someone cancelling the source picker for instance. */
const failures = new Map<'mic' | 'system', (message: string) => void>()

export function deliverCaptureError(track: 'mic' | 'system', message: string): void {
  failures.get(track)?.(message)
}

/** The same count for the window path: the detector does not care who holds the microphone. */
let openMicCaptures = 0

export function rendererUsesMicrophone(): boolean {
  return openMicCaptures > 0
}

export class RendererCapture extends EventEmitter {
  private lastLevel = 0
  private stopped = false

  constructor(private readonly options: RendererCaptureOptions) {
    super()
  }

  get level(): number {
    return this.lastLevel
  }

  start(): void {
    const track = this.options.source === 'mic' ? 'mic' : 'system'
    if (track === 'mic') openMicCaptures++

    listeners.set(track, (samples) => {
      if (this.stopped) return
      // The level is computed here rather than in the renderer, so that it comes
      // from one place for both ways of capturing.
      let sum = 0
      for (const value of samples) sum += value * value
      this.lastLevel = Math.sqrt(sum / Math.max(1, samples.length))
      this.emit('level', this.lastLevel)
      this.emit('samples', samples)
    })

    failures.set(track, (message) => {
      if (!this.stopped) this.emit('error', message)
    })

    const window = getMainWindow()
    if (!window || window.isDestroyed()) {
      // Without a window there is nothing to record with on these platforms, so say so at once.
      queueMicrotask(() => this.emit('error', t('окно приложения закрыто, запись невозможна')))
      return
    }

    window.webContents.send('capture:start', {
      track,
      micDeviceId: this.options.micDeviceId
    })

    // The renderer confirms readiness itself, once the stream is really open.
    const onReady = (id: 'mic' | 'system') => {
      if (id === track && !this.stopped) this.emit('ready')
    }
    readySignals.set(track, onReady)
  }

  stop(): void {
    const track = this.options.source === 'mic' ? 'mic' : 'system'
    if (!this.stopped && track === 'mic') openMicCaptures = Math.max(0, openMicCaptures - 1)
    this.stopped = true
    listeners.delete(track)
    failures.delete(track)
    readySignals.delete(track)

    const window = getMainWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send('capture:stop', { track })
    }
  }
}

const readySignals = new Map<'mic' | 'system', (track: 'mic' | 'system') => void>()

export function deliverCaptureReady(track: 'mic' | 'system'): void {
  readySignals.get(track)?.(track)
}

/**
 * On these platforms Chromium takes the audio; there is no native helper.
 *
 * The environment variable is there for the checks: this path is not used on
 * macOS, but it has to be exercised at least on the microphone, otherwise the
 * code for Windows and Linux stays entirely untested.
 */
export function usesRendererCapture(): boolean {
  if (process.env.SPYLY_FORCE_RENDERER_CAPTURE === '1') return true
  return process.platform !== 'darwin'
}

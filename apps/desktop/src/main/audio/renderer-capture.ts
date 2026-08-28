import { t } from '@spyly/core'
import { EventEmitter } from 'node:events'
import { getMainWindow } from '../index.js'

/**
 * Захват звука руками renderer — путь для Windows и Linux.
 *
 * Интерфейс тот же, что у нативного захвата на macOS: сессия записи не должна
 * знать, откуда берётся звук. Разница только в том, что PCM приходит не из
 * stdout дочернего процесса, а из окна через IPC.
 *
 * Слабое место такого пути — окно: если его закрыть, захват прервётся. Поэтому
 * при закрытии окна во время записи мы не даём ему уничтожиться (см. main).
 */
export const SAMPLE_RATE = 16000

export interface RendererCaptureOptions {
  source: 'system' | 'mic'
  micDeviceId?: string
}

/** Кто сейчас ждёт куски по каждой дорожке. */
const listeners = new Map<'mic' | 'system', (samples: Float32Array) => void>()

/** Вызывается из обработчика IPC, когда renderer прислал очередной кусок. */
export function deliverSamples(track: 'mic' | 'system', samples: Float32Array): void {
  listeners.get(track)?.(samples)
}

/** Ошибка захвата со стороны renderer — например, человек отменил выбор источника. */
const failures = new Map<'mic' | 'system', (message: string) => void>()

export function deliverCaptureError(track: 'mic' | 'system', message: string): void {
  failures.get(track)?.(message)
}

/** Столько же для пути через окно: детектору всё равно, кто именно держит микрофон. */
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
      // Уровень считаем здесь, а не в renderer: так он приходит из одного
      // места для обоих способов захвата.
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
      // Без окна на этих платформах записывать нечем — честнее сказать сразу.
      queueMicrotask(() => this.emit('error', t('окно приложения закрыто, запись невозможна')))
      return
    }

    window.webContents.send('capture:start', {
      track,
      micDeviceId: this.options.micDeviceId
    })

    // Готовность подтверждает сам renderer, когда поток действительно открыт.
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
 * На этих платформах звук берёт Chromium, нативного хелпера нет.
 *
 * Переменная окружения нужна проверкам: на macOS этот путь не используется, но
 * прогнать его хотя бы на микрофоне надо — иначе код для Windows и Linux
 * останется вовсе непроверенным.
 */
export function usesRendererCapture(): boolean {
  if (process.env.SPYLY_FORCE_RENDERER_CAPTURE === '1') return true
  return process.platform !== 'darwin'
}

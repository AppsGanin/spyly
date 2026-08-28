import { t } from '@spyly/core'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AudioApp, AudioDevice } from '../../shared/ipc.js'

/**
 * Обёртка над нативным хелпером захвата звука.
 *
 * На macOS путь через Chromium (`getDisplayMedia` + `audio: 'loopback'`) не
 * работает: аудиотрек приходит уже завершённым, а внутренняя проба разрешений
 * CoreAudio-тапа падает молча. Поэтому и системный звук, и микрофон берёт
 * отдельный бинарник, который отдаёт сырой PCM в stdout, а статус — в stderr.
 */

export const SAMPLE_RATE = 16000

function helperPath(): string {
  const name = 'spyly-audiotap'
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'bin', name)]
    : [
        path.join(app.getAppPath(), '..', '..', 'native', 'macos-audio', '.build', 'release', name),
        path.join(process.cwd(), 'native', 'macos-audio', '.build', 'release', name)
      ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]!
}

export function isSupported(): boolean {
  return process.platform === 'darwin' && existsSync(helperPath())
}

function runOnce(args: string[], timeoutMs = 5000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(helperPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

export async function checkSystemAudioPermission(): Promise<boolean> {
  if (!isSupported()) return false
  const { code } = await runOnce(['check'])
  return code === 0
}

export async function listApps(): Promise<AudioApp[]> {
  if (!isSupported()) return []
  const { stdout } = await runOnce(['list-processes'])
  try {
    const raw = JSON.parse(stdout) as { key: string; name: string; bundleID?: string; pids: number[]; isPlaying: boolean }[]
    return raw.map((a) => ({ key: a.key, name: a.name, bundleID: a.bundleID ?? null, pids: a.pids, isPlaying: a.isPlaying }))
  } catch {
    return []
  }
}

export async function listMics(): Promise<AudioDevice[]> {
  if (!isSupported()) return []
  const { stdout } = await runOnce(['list-mics'])
  try {
    return JSON.parse(stdout) as AudioDevice[]
  } catch {
    return []
  }
}

/** Занят ли микрофон другим приложением — признак идущего созвона. */
export async function micStatus(): Promise<{ busy: boolean; apps: string[] }> {
  if (!isSupported()) return { busy: false, apps: [] }
  const { stdout } = await runOnce(['mic-status'], 3000)
  try {
    const parsed = JSON.parse(stdout) as { busy?: boolean; apps?: string[] }
    return { busy: Boolean(parsed.busy), apps: parsed.apps ?? [] }
  } catch {
    return { busy: false, apps: [] }
  }
}

export interface CaptureOptions {
  /** `system` — звук приложений, `mic` — микрофон. */
  source: 'system' | 'mic'
  micDeviceId?: string
  /** PID приложений; пусто — весь системный звук. */
  includePids?: number[]
  excludePids?: number[]
}

export interface CaptureEvents {
  samples: (chunk: Float32Array) => void
  level: (rms: number) => void
  ready: () => void
  error: (message: string) => void
  exit: (code: number | null) => void
}

/**
 * Сколько наших захватов микрофона сейчас открыто.
 *
 * Детектор созвонов замечает, что микрофон занят, и предлагает начать запись.
 * Но занимать его можем и мы сами — при записи слепка голоса или на проверке
 * звука, — и тогда приложение предлагало записать разговор в ответ на
 * собственные же действия.
 */
let openMicCaptures = 0

export function appUsesMicrophone(): boolean {
  return openMicCaptures > 0
}

/** Живой поток PCM из хелпера. */
export class NativeCapture extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private tail: Buffer = Buffer.alloc(0)
  private stopped = false
  private lastLevel = 0

  constructor(private readonly options: CaptureOptions) {
    super()
  }

  get level(): number {
    return this.lastLevel
  }

  start(): void {
    if (this.options.source === 'mic') openMicCaptures++
    const args: string[] = [this.options.source === 'mic' ? 'capture-mic' : 'capture', '--rate', String(SAMPLE_RATE)]
    if (this.options.source === 'mic' && this.options.micDeviceId) {
      args.push('--mic-device', this.options.micDeviceId)
    }
    for (const pid of this.options.includePids ?? []) args.push('--include-pid', String(pid))
    for (const pid of this.options.excludePids ?? []) args.push('--exclude-pid', String(pid))

    const child = spawn(helperPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    child.stdout.on('data', (chunk: Buffer) => this.onAudio(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.onStatus(chunk))
    child.on('error', (err) => this.emit('error', err.message))
    child.on('close', (code) => {
      this.child = null
      if (!this.stopped) this.emit('exit', code)
    })
  }

  /** PCM приходит произвольными кусками; собираем по 4 байта на сэмпл. */
  private onAudio(chunk: Buffer): void {
    const buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk
    const usable = buf.length - (buf.length % 4)
    if (usable > 0) {
      const samples = new Float32Array(usable / 4)
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(i * 4)
      this.emit('samples', samples)
    }
    this.tail = usable === buf.length ? Buffer.alloc(0) : buf.subarray(usable)
  }

  private onStatus(chunk: Buffer): void {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed) as { type: string; rms?: number; message?: string }
        if (msg.type === 'level' && typeof msg.rms === 'number') {
          this.lastLevel = msg.rms
          this.emit('level', msg.rms)
        } else if (msg.type === 'ready') {
          this.emit('ready')
        } else if (msg.type === 'error') {
          this.emit('error', msg.message ?? t('неизвестная ошибка захвата'))
        }
      } catch {
        // Не-JSON в stderr — например сообщение системного логгера; игнорируем.
      }
    }
  }

  stop(): void {
    if (!this.stopped && this.options.source === 'mic') openMicCaptures = Math.max(0, openMicCaptures - 1)
    this.stopped = true
    const child = this.child
    if (!child) return
    child.kill('SIGTERM')
    // Хелпер сам сносит приватный агрегат; если завис — добиваем, иначе
    // устройство останется висеть в системе.
    setTimeout(() => {
      if (this.child === child) child.kill('SIGKILL')
    }, 1500).unref?.()
    this.child = null
  }
}

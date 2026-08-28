import { t } from '@spyly/core'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { modelPath } from './models.js'
import { preferredModel } from '../providers/asr/whisper-cpp.js'

/**
 * Долгоживущий whisper.cpp для live-режима.
 *
 * Запускать `whisper-cli` на каждый кусок нельзя: модель грузится по секунде и
 * дольше, и весь бюджет задержки уходит на это. Сервер держит её в памяти.
 */

let child: ChildProcess | null = null
let port = 0
let ready: Promise<void> | null = null

function serverPath(): string {
  const name = 'whisper-server'
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'bin', name)]
    : [
        path.join(process.cwd(), 'native', 'whisper', 'build', 'bin', name),
        path.join(app.getAppPath(), '..', '..', 'native', 'whisper', 'build', 'bin', name)
      ]
  return candidates.find(existsSync) ?? candidates[0]!
}

export function isServerAvailable(): boolean {
  return existsSync(serverPath())
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const found = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(found))
    })
  })
}

async function waitForReady(targetPort: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!child) throw new Error(t('whisper-server не запустился'))
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/`, { signal: AbortSignal.timeout(800) })
      if (response.status < 500) return
    } catch {
      // сервер ещё поднимается — это нормально первые секунды
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(t('whisper-server не ответил вовремя'))
}

export async function startWhisperServer(language: string): Promise<void> {
  if (ready) return ready
  if (!isServerAvailable()) throw new Error(t('не найден whisper-server'))

  const model = modelPath(preferredModel())
  if (!model || !existsSync(model)) throw new Error(t('модель Whisper не скачана'))

  ready = (async () => {
    port = await freePort()
    child = spawn(
      serverPath(),
      [
        '-m', model,
        '--host', '127.0.0.1',
        '--port', String(port),
        '-l', language,
        '-t', String(Math.max(2, Math.min(8, os.cpus().length - 2)))
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    child.on('exit', () => {
      child = null
      ready = null
      port = 0
    })
    await waitForReady(port)
  })()

  try {
    await ready
  } catch (error) {
    stopWhisperServer()
    throw error
  }
}

export function stopWhisperServer(): void {
  const dying = child
  child = null
  ready = null
  port = 0
  if (!dying) return
  dying.kill('SIGTERM')
  // Модель весит гигабайты, и сервер не всегда успевает закрыться сам:
  // оставшийся жить процесс держит их в памяти до перезагрузки.
  setTimeout(() => {
    if (!dying.killed) dying.kill('SIGKILL')
  }, 2000).unref?.()
}

/**
 * Убрать серверы, оставшиеся от прошлых запусков.
 *
 * Если приложение сняли принудительно или оно упало, дочерний процесс остаётся
 * жить с родителем `1` — и держит модель в оперативной памяти. За несколько
 * таких запусков набирается десяток серверов и десятки гигабайт: живая
 * расшифровка после этого просто перестаёт успевать.
 */
export async function killOrphanServers(): Promise<number> {
  if (process.platform === 'win32') return 0
  const { execFile } = await import('node:child_process')

  const list = await new Promise<string>((resolve) => {
    execFile('ps', ['-eo', 'pid=,ppid=,comm='], { maxBuffer: 4_000_000 }, (error, stdout) =>
      resolve(error ? '' : stdout)
    )
  })

  let killed = 0
  for (const line of list.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, pid, ppid, command] = match
    if (!command?.includes('whisper-server')) continue
    // Только осиротевшие: у живого приложения свой сервер, и его трогать нельзя.
    if (ppid !== '1') continue
    if (Number(pid) === process.pid) continue
    try {
      process.kill(Number(pid), 'SIGKILL')
      killed++
    } catch {
      // Процесс мог закончиться сам, пока мы читали список.
    }
  }
  return killed
}

interface InferenceSegment {
  text?: string
}

/**
 * Расшифровать кусок в уже поднятом сервере.
 *
 * Возвращается только текст: точные таймкоды даст финальный проход по целому
 * файлу, а склеивать их из кусков — заведомо хуже.
 */
export async function transcribeChunk(wav: Buffer, language: string): Promise<string> {
  if (!child || !port) throw new Error(t('whisper-server не запущен'))

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('temperature', '0')
  form.append('response_format', 'json')
  form.append('language', language)

  const response = await fetch(`http://127.0.0.1:${port}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(t('whisper-server ответил {response_status}', { response_status: response.status }))

  const data = (await response.json()) as { text?: string; transcription?: InferenceSegment[] }
  if (typeof data.text === 'string' && data.text.trim()) return data.text.trim()
  return (data.transcription ?? [])
    .map((s) => (s.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim()
}

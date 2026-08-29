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
 * A long-lived whisper.cpp for live mode.
 *
 * Running `whisper-cli` per chunk will not do: the model takes a second or
 * more to load, and the whole latency budget goes on that. The server keeps it
 * in memory.
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
      // the server is still coming up, which is normal for the first seconds
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
  // The model weighs gigabytes, and the server does not always manage to shut
  // down by itself: a process left alive holds them in memory until a reboot.
  setTimeout(() => {
    if (!dying.killed) dying.kill('SIGKILL')
  }, 2000).unref?.()
}

/**
 * Remove servers left over from earlier runs.
 *
 * If the application was force-quit or crashed, the child process stays alive
 * with parent `1`, holding a model in memory. Over a few such runs a dozen
 * servers and tens of gigabytes pile up, and live transcription simply stops
 * keeping up after that.
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
    // Only the orphaned ones: a live application has its own server, which must not be touched.
    if (ppid !== '1') continue
    if (Number(pid) === process.pid) continue
    try {
      process.kill(Number(pid), 'SIGKILL')
      killed++
    } catch {
      // The process may have ended by itself while we were reading the list.
    }
  }
  return killed
}

interface InferenceSegment {
  text?: string
}

/**
 * Transcribe a chunk in a server that is already up.
 *
 * Only the text comes back: exact timestamps will come from the final pass
 * over the whole file, and gluing them together out of chunks is bound to be
 * worse.
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

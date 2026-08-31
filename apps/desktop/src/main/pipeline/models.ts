import { t } from '@spyly/core'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { ModelInfo } from '../../shared/ipc.js'
import { send } from '../index.js'

interface ModelSpec {
  id: string
  name: string
  purpose: ModelInfo['purpose']
  url: string
  /** The file name on disk; for archives, the folder after extraction. */
  file: string
  sizeBytes: number
  archive?: 'tar.bz2'
  /** What the variant is called for a person: they choose quality, not a file. */
  tier?: string
  /** What this variant does differently in practice. */
  tradeoff?: string
  /** A sensible default for its engine. */
  recommended?: boolean
}

/**
 * Models are not baked into the bundle: large-v3-turbo alone weighs half a
 * gigabyte, and a smaller one is enough for most people. They are downloaded
 * on demand.
 */
export const MODELS: ModelSpec[] = [
  {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper large-v3-turbo',
    purpose: 'asr',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    sizeBytes: 574_000_000,
    tier: t('Оптимальная'),
    tradeoff: t('Лучшее сочетание точности и скорости, знает все языки — подходит большинству'),
    recommended: true
  },
  {
    id: 'whisper-large-v3',
    name: 'Whisper large-v3',
    purpose: 'asr',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin',
    file: 'ggml-large-v3-q5_0.bin',
    sizeBytes: 1_081_000_000,
    tier: t('Максимальная точность'),
    tradeoff: t('Точнее на плохом звуке и в именах, но считает примерно вдвое дольше')
  },
  {
    id: 'parakeet-tdt-v3',
    name: 'Parakeet TDT v3',
    purpose: 'asr',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    file: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    sizeBytes: 487_000_000,
    archive: 'tar.bz2',
    tier: t('Быстрая многоязычная'),
    tradeoff: t('Быстрее Whisper и не выдумывает лишнего. 25 языков, включая русский')
  },
  {
    id: 'nemotron-3.5',
    name: 'Nemotron Speech 3.5',
    purpose: 'live',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11.tar.bz2',
    file: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11',
    sizeBytes: 475_000_000,
    archive: 'tar.bz2',
    tier: t('Многоязычная'),
    tradeoff:
      t('35 языков, включая русский. Расшифровывает на лету — на ней работает живой текст по ходу разговора')
  },
  {
    id: 'vad',
    name: t('Детектор речи (Silero)'),
    purpose: 'vad',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    file: 'silero_vad.onnx',
    sizeBytes: 2_300_000
  }
]

export function modelsDir(): string {
  return path.join(app.getPath('userData'), 'models')
}

export function modelPath(id: string): string | null {
  const spec = MODELS.find((m) => m.id === id)
  if (!spec) return null
  return path.join(modelsDir(), spec.file)
}

export function isDownloaded(id: string): boolean {
  const p = modelPath(id)
  return p !== null && existsSync(p)
}

export async function listModels(): Promise<ModelInfo[]> {
  const out: ModelInfo[] = []
  for (const spec of MODELS) {
    const p = path.join(modelsDir(), spec.file)
    let downloaded = existsSync(p)
    let size = spec.sizeBytes
    if (downloaded && !spec.archive) {
      try {
        size = (await stat(p)).size
      } catch {
        downloaded = false
      }
    }
    out.push({
      id: spec.id,
      name: spec.name,
      sizeBytes: size,
      downloaded,
      downloading: inFlight.has(spec.id),
      progress: inFlight.get(spec.id)?.progress,
      purpose: spec.purpose,
      tier: spec.tier,
      tradeoff: spec.tradeoff,
      recommended: spec.recommended ?? false,
      paused: !inFlight.has(spec.id) && partialBytes(spec.id) > 0,
      resumableBytes: partialBytes(spec.id)
    })
  }
  return out
}

interface Download {
  progress: number
  controller: AbortController
  /** Pausing leaves the partial download on disk, cancelling erases it. */
  intent: 'run' | 'pause' | 'cancel'
}

const inFlight = new Map<string, Download>()

export function downloadState(id: string): { progress: number; paused: boolean } | null {
  const active = inFlight.get(id)
  return active ? { progress: active.progress, paused: false } : null
}

/** Whether there is a partial download, which shows the download can be resumed. */
export function partialBytes(id: string): number {
  const spec = MODELS.find((m) => m.id === id)
  if (!spec) return 0
  const part = path.join(modelsDir(), `${spec.file}.part`)
  if (!existsSync(part)) return 0
  try {
    return statSync(part).size
  } catch {
    return 0
  }
}

function report(spec: ModelSpec, progress: number, downloaded: boolean): void {
  send('models:progress', {
    id: spec.id,
    name: spec.name,
    sizeBytes: spec.sizeBytes,
    downloaded,
    // Whether anything is actually running, rather than a guess from the number.
    downloading: inFlight.has(spec.id),
    progress: downloaded ? 1 : progress,
    purpose: spec.purpose,
    paused: false,
    resumableBytes: downloaded ? 0 : partialBytes(spec.id)
  })
}

/**
 * A download that can be resumed.
 *
 * The models are large, and on a poor connection it matters not to start over:
 * what was downloaded sits alongside in `.part`, and the next attempt asks the
 * server for the remainder through a Range header.
 */
export async function downloadModel(id: string): Promise<void> {
  const spec = MODELS.find((m) => m.id === id)
  if (!spec) throw new Error(t('неизвестная модель: {id}', { id: id }))
  if (inFlight.has(id)) return

  await mkdir(modelsDir(), { recursive: true })
  const target = path.join(modelsDir(), spec.file)
  const tmp = `${target}.part`
  const controller = new AbortController()
  const entry: Download = { progress: 0, controller, intent: 'run' }
  inFlight.set(id, entry)

  try {
    const already = existsSync(tmp) ? statSync(tmp).size : 0
    const response = await fetch(spec.url, {
      signal: controller.signal,
      headers: already > 0 ? { range: `bytes=${already}-` } : {}
    })

    // 206 means the server handed over the remainder; 200 to a Range request means
    // it does not support resuming and sent the whole file: we start over.
    const resuming = already > 0 && response.status === 206
    if (!response.ok || !response.body) throw new Error(t('сервер ответил {response_status}', { response_status: response.status }))

    const totalHeader = Number(response.headers.get('content-length') ?? 0)
    const total = resuming ? already + totalHeader : totalHeader || spec.sizeBytes
    let received = resuming ? already : 0

    const file = createWriteStream(tmp, resuming ? { flags: 'a' } : { flags: 'w' })
    const reader = response.body.getReader()
    let lastReport = 0

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (!file.write(Buffer.from(value))) {
        await new Promise((r) => file.once('drain', r))
      }
      const now = Date.now()
      if (now - lastReport > 250) {
        lastReport = now
        entry.progress = total > 0 ? received / total : 0
        report(spec, entry.progress, false)
      }
    }
    await new Promise<void>((resolve, reject) => file.end((err: unknown) => (err ? reject(err) : resolve())))

    if (spec.archive === 'tar.bz2') {
      await extractTarBz2(tmp, modelsDir())
      await rm(tmp, { force: true })
    } else {
      const { rename } = await import('node:fs/promises')
      await rename(tmp, target)
    }
    report(spec, 1, true)
  } catch (error) {
    const intent = inFlight.get(id)?.intent ?? 'run'
    if (intent === 'cancel') {
      await rm(tmp, { force: true })
      report(spec, 0, false)
    } else if (intent === 'pause') {
      // The partial download stays on disk: it will be useful when resuming.
      report(spec, 0, false)
    } else {
      await rm(tmp, { force: true })
      send('toast', { kind: 'error', text: t('Не удалось скачать «{name}»: {error}', { name: spec.name, error: String(error) }) })
      report(spec, 0, false)
      throw error
    }
  } finally {
    inFlight.delete(id)
  }
}

/** Stop the download, keeping what has been downloaded. */
export function pauseDownload(id: string): void {
  const active = inFlight.get(id)
  if (!active) return
  active.intent = 'pause'
  active.controller.abort()
}

/** Stop the download and erase the partial file. */
export async function cancelDownload(id: string): Promise<void> {
  const active = inFlight.get(id)
  if (active) {
    active.intent = 'cancel'
    active.controller.abort()
    return
  }
  // The download is no longer running, so the leftover piece goes.
  const spec = MODELS.find((m) => m.id === id)
  if (!spec) return
  await rm(path.join(modelsDir(), `${spec.file}.part`), { force: true })
  report(spec, 0, false)
}

export async function removeModel(id: string): Promise<void> {
  await cancelDownload(id)
  const p = modelPath(id)
  if (p && existsSync(p)) await rm(p, { recursive: true, force: true })
  // Reported after the file is gone, so the interface hears the final state and
  // not the one from the middle of the removal.
  const spec = MODELS.find((m) => m.id === id)
  if (spec) report(spec, 0, false)
}

/** tar ships with macOS and most distributions; no separate dependency needed. */
async function extractTarBz2(archive: string, dest: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xjf', archive, '-C', dest], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(t('tar завершился с кодом {code}', { code: code ?? '?' })))))
  })
}

/** Recognition models, from the fast one to the accurate one. */
export function asrModels(): string[] {
  return [
    'whisper-large-v3-turbo',
    'whisper-large-v3',
    'parakeet-tdt-v3'
  ]
}

/** Nothing will be transcribed until the bare minimum has been downloaded. */
export function missingRequiredModels(asrModelId: string): ModelSpec[] {
  return MODELS.filter(
    (m) => (m.id === asrModelId || m.purpose === 'vad') && !isDownloaded(m.id)
  )
}

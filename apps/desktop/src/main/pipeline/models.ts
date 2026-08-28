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
  /** Имя файла на диске; для архивов — папка после распаковки. */
  file: string
  sizeBytes: number
  archive?: 'tar.bz2'
  /** Как вариант называется для человека: он выбирает качество, а не файл. */
  tier?: string
  /** Чем этот вариант отличается на практике. */
  tradeoff?: string
  /** Разумный выбор по умолчанию для своего движка. */
  recommended?: boolean
}

/**
 * Модели не вшиты в бандл: large-v3-turbo один весит полгигабайта, а
 * большинству пользователей хватит меньшей. Качаются по требованию.
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
    id: 'gigaam-v3-ru',
    name: 'GigaAM v3',
    purpose: 'asr',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16.tar.bz2',
    file: 'sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16',
    sizeBytes: 163_000_000,
    archive: 'tar.bz2',
    tier: t('Только русский'),
    tradeoff: t('На русском точнее и быстрее, сама расставляет знаки препинания. Только русский')
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
    purpose: 'asr',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11.tar.bz2',
    file: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11',
    sizeBytes: 475_000_000,
    archive: 'tar.bz2',
    tier: t('Многоязычная'),
    tradeoff:
      t('35 языков, включая русский. Расшифровывает на лету — на ней работает живой текст по ходу разговора')
  },
  {
    id: 'whisper-medium',
    name: 'Whisper medium',
    purpose: 'asr',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin',
    file: 'ggml-medium-q5_0.bin',
    sizeBytes: 539_000_000,
    tier: t('Средняя'),
    tradeoff: t('Быстрее large, но чаще ошибается в именах и терминах')
  },
  {
    id: 'whisper-small',
    name: 'Whisper small',
    purpose: 'asr',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
    file: 'ggml-small-q5_1.bin',
    sizeBytes: 190_000_000,
    tier: t('Лёгкая'),
    tradeoff: t('Самая быстрая: для слабых машин и черновиков')
  },
  {
    id: 'segmentation',
    name: t('Разделение по голосам (pyannote)'),
    purpose: 'diarization',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
    file: 'sherpa-onnx-pyannote-segmentation-3-0',
    sizeBytes: 7_300_000,
    archive: 'tar.bz2'
  },
  {
    id: 'embedding',
    name: t('Слепки голоса (3D-Speaker)'),
    purpose: 'embedding',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
    file: '3dspeaker_eres2net_base.onnx',
    sizeBytes: 39_800_000
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
  /** Пауза оставляет докачку на диске, отмена — стирает. */
  intent: 'run' | 'pause' | 'cancel'
}

const inFlight = new Map<string, Download>()

export function downloadState(id: string): { progress: number; paused: boolean } | null {
  const active = inFlight.get(id)
  return active ? { progress: active.progress, paused: false } : null
}

/** Есть ли недокачанный кусок — по нему видно, что загрузку можно продолжить. */
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
    progress: downloaded ? 1 : progress,
    purpose: spec.purpose,
    paused: false,
    resumableBytes: downloaded ? 0 : partialBytes(spec.id)
  })
}

/**
 * Скачивание с возможностью продолжить.
 *
 * Модели большие, и на плохой связи важно не начинать заново: недокачанное
 * лежит рядом в `.part`, и следующая попытка просит у сервера остаток через
 * заголовок Range.
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

    // 206 — сервер отдал остаток; 200 на запрос с Range означает, что докачку
    // он не поддерживает и прислал файл целиком: начинаем заново.
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
      // Докачку оставляем на диске: она пригодится при возобновлении.
      report(spec, 0, false)
    } else {
      await rm(tmp, { force: true })
      send('toast', { kind: 'error', text: `Не удалось скачать «${spec.name}»: ${String(error)}` })
      report(spec, 0, false)
      throw error
    }
  } finally {
    inFlight.delete(id)
  }
}

/** Остановить загрузку, сохранив уже скачанное. */
export function pauseDownload(id: string): void {
  const active = inFlight.get(id)
  if (!active) return
  active.intent = 'pause'
  active.controller.abort()
}

/** Остановить загрузку и стереть недокачанное. */
export async function cancelDownload(id: string): Promise<void> {
  const active = inFlight.get(id)
  if (active) {
    active.intent = 'cancel'
    active.controller.abort()
    return
  }
  // Загрузка уже не идёт — убираем оставшийся кусок.
  const spec = MODELS.find((m) => m.id === id)
  if (!spec) return
  await rm(path.join(modelsDir(), `${spec.file}.part`), { force: true })
  report(spec, 0, false)
}

export async function removeModel(id: string): Promise<void> {
  await cancelDownload(id)
  const p = modelPath(id)
  if (p && existsSync(p)) await rm(p, { recursive: true, force: true })
}

/** tar есть в macOS и в большинстве дистрибутивов; отдельная зависимость не нужна. */
async function extractTarBz2(archive: string, dest: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xjf', archive, '-C', dest], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(t('tar завершился с кодом {code}', { code: code ?? '?' })))))
  })
}

/** Модели распознавания, от быстрой к точной. */
export function asrModels(): string[] {
  return [
    'whisper-large-v3-turbo',
    'whisper-large-v3',
    'gigaam-v3-ru',
    'parakeet-tdt-v3',
    'nemotron-3.5',
    'whisper-medium',
    'whisper-small'
  ]
}

/** Ничего не расшифруется, пока не скачано минимально необходимое. */
export function missingRequiredModels(asrModelId: string): ModelSpec[] {
  return MODELS.filter(
    (m) => (m.id === asrModelId || m.purpose === 'diarization' || m.purpose === 'embedding' || m.purpose === 'vad') && !isDownloaded(m.id)
  )
}

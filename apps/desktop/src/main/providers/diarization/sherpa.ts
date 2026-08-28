import { t } from '@spyly/core'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { SpeakerTurn } from '@spyly/core'
import { readWavPcm16, type DecodedWav } from '../../audio/wav.js'
import { isDownloaded, modelPath, modelsDir } from '../../pipeline/models.js'
import type { DiarizationProvider } from '../types.js'
import type { DiarizeJob, DiarizeReply } from '../../pipeline/diarize-worker.js'

// Нативный аддон грузится через require: у него нет ESM-точки входа.
const require = createRequire(import.meta.url)

interface SherpaSegment {
  start: number
  end: number
  speaker: number
}

interface SherpaModule {
  OfflineSpeakerDiarization: new (config: unknown) => {
    sampleRate: number
    process(samples: Float32Array): SherpaSegment[]
  }
  OnlineRecognizer: new (config: unknown) => unknown
  OfflineRecognizer: new (config: unknown) => {
    createStream(): { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void }
    decode(stream: unknown): void
    getResult(stream: unknown): { text?: string }
  }
  SpeakerEmbeddingExtractor: new (config: unknown) => {
    dim: number
    createStream(): { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void }
    isReady(stream: unknown): boolean
    /** Второй аргумент выключает внешний буфер, запрещённый в Electron. */
    compute(stream: unknown, enableExternalBuffer: boolean): Float32Array
  }
}

let cached: SherpaModule | null = null

export function sherpa(): SherpaModule {
  if (!cached) cached = require('sherpa-onnx-node') as SherpaModule
  return cached
}

export function segmentationModelPath(): string {
  return path.join(modelsDir(), 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx')
}

export function embeddingModelPath(): string {
  return modelPath('embedding') ?? ''
}

export async function readWave(file: string): Promise<DecodedWav> {
  return readWavPcm16(file)
}

/**
 * Порог склейки говорящих.
 *
 * Ниже — каждая фраза становится отдельным «участником»: на реальном
 * получасовом разговоре троих человек значение 0.5 давало полсотни кластеров,
 * и расшифровка превращалась в мусор. Значение подобрано замером на настоящих
 * записях, а не взято из примера к библиотеке.
 */
const CLUSTER_THRESHOLD = 0.9

export const sherpaDiarizationProvider: DiarizationProvider = {
  id: 'sherpa-onnx',
  name: t('Разделение по голосам (локально)'),
  local: true,

  async ready() {
    if (!existsSync(segmentationModelPath())) return { ready: false, hint: t('модель сегментации не скачана') }
    if (!isDownloaded('embedding')) return { ready: false, hint: t('модель слепков голоса не скачана') }
    return { ready: true }
  },

  async diarize(wavPath, options = {}) {
    if (!existsSync(wavPath)) return []
    const job: DiarizeJob = {
      wavPath,
      segmentation: segmentationModelPath(),
      embedding: embeddingModelPath(),
      // -1 значит «определить число говорящих самому»: заранее его знать
      // неоткуда, в переговорке может оказаться кто угодно.
      numClusters: options.numSpeakers ?? -1,
      threshold: options.threshold ?? CLUSTER_THRESHOLD
    }

    // Счёт синхронный и долгий, поэтому идёт в отдельном процессе. Если тот не
    // запустился — считаем на месте: заморозка на несколько секунд неприятна,
    // но лучше, чем несделанная работа.
    const turns = await diarizeInWorker(job).catch((error: unknown) => {
      process.stderr.write(`[голоса] отдельный процесс не сработал: ${String(error)}\n`)
      return null
    })
    options.onProgress?.(1)
    return turns ?? diarizeHere(job)
  }
}

/** Тот же счёт в главном процессе — запасной путь. */
async function diarizeHere(job: DiarizeJob): Promise<SpeakerTurn[]> {
  const { OfflineSpeakerDiarization } = sherpa()
  const wave = await readWavPcm16(job.wavPath)
  if (wave.samples.length === 0) return []

  const engine = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: job.segmentation }, numThreads: 4 },
    embedding: { model: job.embedding, numThreads: 4 },
    clustering: { numClusters: job.numClusters, threshold: job.threshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  return engine
    .process(wave.samples)
    .map<SpeakerTurn>((s) => ({ start: s.start, end: s.end, cluster: s.speaker }))
    .sort((a, b) => a.start - b.start)
}

/** Час записи считается минутами; ждём с запасом, но не бесконечно. */
const WORKER_TIMEOUT_MS = 20 * 60_000

async function diarizeInWorker(job: DiarizeJob): Promise<SpeakerTurn[]> {
  const { utilityProcess, app } = await import('electron')
  // Путь один и тот же в собранном приложении и при разработке: точка входа
  // лежит рядом с главной.
  const entry = path.join(app.getAppPath(), 'out', 'main', 'diarize-worker.js')
  if (!existsSync(entry)) throw new Error(t('не найден {entry}', { entry: entry }))

  return new Promise<SpeakerTurn[]>((resolve, reject) => {
    const child = utilityProcess.fork(entry, [], { stdio: 'inherit' })
    let done = false
    const finish = (run: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      run()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(t('разделение по голосам не уложилось во время')))),
      WORKER_TIMEOUT_MS
    )

    child.on('message', (reply: DiarizeReply) => {
      if (reply.ok) finish(() => resolve(reply.turns))
      else finish(() => reject(new Error(reply.error)))
    })
    child.on('exit', (code) => {
      finish(() => reject(new Error(t('процесс завершился с кодом {code}', { code: code }))))
    })
    child.postMessage(job)
  })
}

/**
 * Усреднённый слепок голоса кластера.
 *
 * Берём только отрезки этого кластера, склеиваем и считаем один embedding:
 * усреднение по нескольким кускам устойчивее, чем слепок с одной фразы.
 */
export function embedSpeaker(
  samples: Float32Array,
  sampleRate: number,
  turns: readonly SpeakerTurn[],
  cluster: number,
  maxSeconds = 30
): number[] | null {
  const wanted = turns.filter((t) => t.cluster === cluster)
  if (wanted.length === 0) return null

  const pieces: Float32Array[] = []
  let total = 0
  for (const turn of wanted) {
    const from = Math.max(0, Math.floor(turn.start * sampleRate))
    const to = Math.min(samples.length, Math.ceil(turn.end * sampleRate))
    if (to <= from) continue
    const piece = samples.subarray(from, to)
    pieces.push(piece)
    total += piece.length
    if (total >= maxSeconds * sampleRate) break
  }
  if (total < sampleRate * 0.5) return null // меньше полусекунды речи — слепок будет мусорным

  const joined = new Float32Array(total)
  let offset = 0
  for (const piece of pieces) {
    joined.set(piece, offset)
    offset += piece.length
  }

  const { SpeakerEmbeddingExtractor } = sherpa()
  const extractor = new SpeakerEmbeddingExtractor({ model: embeddingModelPath(), numThreads: 4 })
  const stream = extractor.createStream()
  stream.acceptWaveform({ sampleRate, samples: joined })
  stream.inputFinished()
  if (!extractor.isReady(stream)) return null
  return Array.from(extractor.compute(stream, false))
}

import { t } from '@spyly/core'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Word } from '@spyly/core'
import { readWavPcm16 } from '../../audio/wav.js'
import { specById, type SherpaSpec } from './sherpa-specs.js'

/**
 * Расшифровка моделями sherpa-onnx в отдельном процессе.
 *
 * Библиотека считает синхронно, кусками по 30–120 секунд звука. В главном
 * процессе каждый такой кусок замораживал приложение на секунды подряд — а он
 * же принимает звук, если параллельно идёт новая запись. Уступать поток между
 * кусками смысла нет: при 0.1× от реального времени блокировка занимает почти
 * всё время работы.
 */

const require = createRequire(import.meta.url)

export interface AsrJob {
  specId: string
  wavPath: string
  /** Папка с моделями: `app.getPath` в дочернем процессе недоступен. */
  modelsDir: string
}

export type AsrReply =
  | { type: 'progress'; value: number }
  | { type: 'done'; words: Word[] }
  | { type: 'error'; message: string }

let modelsRoot = ''

function fileIn(spec: SherpaSpec, name: string): string {
  return path.join(modelsRoot, spec.dir, name)
}

function modelConfigFor(spec: SherpaSpec): Record<string, unknown> {
  const base = {
    tokens: fileIn(spec, 'tokens.txt'),
    numThreads: 4,
    provider: 'cpu',
    debug: false
  }
  if ('model' in spec.files) {
    return { ...base, nemoCtc: { model: fileIn(spec, spec.files.model) } }
  }
  return {
    ...base,
    transducer: {
      encoder: fileIn(spec, spec.files.encoder),
      decoder: fileIn(spec, spec.files.decoder),
      joiner: fileIn(spec, spec.files.joiner)
    },
    // Тип нужен, чтобы движок выбрал верный декодер: у NeMo он свой.
    ...(spec.streaming ? {} : { modelType: 'nemo_transducer' })
  }
}

/**
 * Загруженные распознаватели.
 *
 * Модель весит сотни мегабайт и грузится секунды: держим её в памяти между
 * вызовами, но по одной — переключение модели должно освобождать прошлую.
 */
const loaded = new Map<string, unknown>()

function getEngine(spec: SherpaSpec): unknown {
  const hit = loaded.get(spec.id)
  if (hit) return hit

  // Держим только текущую: две модели по полгигабайта в памяти — уже много.
  loaded.clear()

  const { OfflineRecognizer, OnlineRecognizer } = require('sherpa-onnx-node') as {
    OfflineRecognizer: new (config: unknown) => unknown
    OnlineRecognizer: new (config: unknown) => unknown
  }
  const config = { modelConfig: modelConfigFor(spec) }
  const engine = spec.streaming ? new OnlineRecognizer(config) : new OfflineRecognizer(config)
  loaded.set(spec.id, engine)
  return engine
}

interface OfflineEngine {
  createStream(): { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void }
  decode(stream: unknown): void
  getResult(stream: unknown): { text?: string }
}

interface OnlineEngine {
  createStream(): {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
    inputFinished(): void
  }
  isReady(stream: unknown): boolean
  decode(stream: unknown): void
  getResult(stream: unknown): { text?: string }
}

/** Распознать один кусок — потоковой моделью или обычной. */
function decodeChunk(spec: SherpaSpec, samples: Float32Array, sampleRate: number): string {
  const engine = getEngine(spec)
  if (spec.streaming) {
    const online = engine as OnlineEngine
    const stream = online.createStream()
    stream.acceptWaveform({ sampleRate, samples })
    // Досказать больше нечего: кусок закончился, можно добирать остаток.
    stream.inputFinished()
    while (online.isReady(stream)) online.decode(stream)
    return (online.getResult(stream).text ?? '').trim()
  }

  const offline = engine as OfflineEngine
  const stream = offline.createStream()
  stream.acceptWaveform({ sampleRate, samples })
  offline.decode(stream)
  return (offline.getResult(stream).text ?? '').trim()
}

/**
 * Слова с равномерными таймкодами.
 *
 * Модель отдаёт текст без разметки по времени, а дальше по конвейеру слова
 * нужно разложить по говорящим. Распределяем их по длине куска пропорционально
 * числу символов: точнее, чем поровну, и достаточно для сопоставления с
 * отрезками разделения по голосам.
 */
function spreadWords(text: string, start: number, end: number): Word[] {
  const parts = text.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return []

  const total = parts.reduce((sum, word) => sum + word.length, 0)
  const span = Math.max(0.001, end - start)
  const out: Word[] = []
  let at = start
  for (const word of parts) {
    const share = (word.length / total) * span
    out.push({ text: word, start: at, end: at + share })
    at += share
  }
  return out
}

/**
 * Нарезка на куски прямо в памяти.
 *
 * Резать обязательно: получасовая запись, отданная модели целиком, кладёт
 * процесс — нативный сбой без всякого сообщения. Границу ищем в ближайшей
 * тихой точке, чтобы не рвать посреди слова, но если тишины нет, режем по
 * времени: испорченный стык лучше, чем упавшая расшифровка.
 */
function chunkSamples(
  samples: Float32Array,
  sampleRate: number,
  chunkSeconds: number
): { from: number; to: number }[] {
  const window = Math.round(sampleRate * chunkSeconds)
  if (samples.length <= window) return [{ from: 0, to: samples.length }]

  // Тихую точку ищем в последних десяти секундах куска.
  const searchSpan = Math.round(sampleRate * 10)
  const frame = Math.round(sampleRate * 0.05)

  const out: { from: number; to: number }[] = []
  let from = 0
  while (from < samples.length) {
    const target = Math.min(from + window, samples.length)
    if (target >= samples.length) {
      out.push({ from, to: samples.length })
      break
    }

    let best = target
    let quietest = Infinity
    for (let at = Math.max(from + frame, target - searchSpan); at + frame <= target; at += frame) {
      let energy = 0
      for (let i = at; i < at + frame; i++) energy += samples[i]! * samples[i]!
      if (energy < quietest) {
        quietest = energy
        best = at + Math.floor(frame / 2)
      }
    }
    out.push({ from, to: best })
    from = best
  }
  return out
}


async function run(job: AsrJob): Promise<AsrReply> {
  const spec = specById(job.specId)
  if (!spec) return { type: 'error', message: t('неизвестная модель: {job_specId}', { job_specId: job.specId }) }
  modelsRoot = job.modelsDir

  const { samples, sampleRate } = await readWavPcm16(job.wavPath)
  if (samples.length === 0) return { type: 'done', words: [] }

  const pieces = chunkSamples(samples, sampleRate, spec.chunkSeconds)
  const words: Word[] = []
  for (const [index, piece] of pieces.entries()) {
    // Копия, а не подвыборка: нативный слой не должен видеть чужой буфер.
    const slice = samples.slice(piece.from, piece.to)
    if (slice.length === 0) continue
    const text = decodeChunk(spec, slice, sampleRate)
    if (text) words.push(...spreadWords(text, piece.from / sampleRate, piece.to / sampleRate))
    process.parentPort?.postMessage({ type: 'progress', value: (index + 1) / pieces.length })
  }
  return { type: 'done', words }
}

process.parentPort?.on('message', (event: { data: AsrJob }) => {
  void run(event.data)
    .catch((error: unknown) => ({
      type: 'error' as const,
      message: error instanceof Error ? error.message : String(error)
    }))
    .then((reply) => process.parentPort?.postMessage(reply))
})

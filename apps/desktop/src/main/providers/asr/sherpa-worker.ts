import { t } from '@spyly/core'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Word } from '@spyly/core'
import { readWavPcm16 } from '../../audio/wav.js'
import { specById, type SherpaSpec } from './sherpa-specs.js'

/**
 * Transcription with sherpa-onnx models in a separate process.
 *
 * The library computes synchronously, in chunks of 30 to 120 seconds of audio.
 * In the main process every such chunk froze the application for seconds on
 * end, and that same process takes in audio if a new recording is running
 * alongside. Yielding the thread between chunks makes no difference: at 0.1x
 * real time the blocking takes up almost all of the work.
 */

const require = createRequire(import.meta.url)

export interface AsrJob {
  specId: string
  wavPath: string
  /** The models folder: `app.getPath` is not available in a child process. */
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
    // The type is needed so the engine picks the right decoder: NeMo has its own.
    ...(spec.streaming ? {} : { modelType: 'nemo_transducer' })
  }
}

/**
 * The recognisers that are loaded.
 *
 * A model weighs hundreds of megabytes and takes seconds to load: it is kept
 * in memory between calls, but only one at a time, as switching models has to
 * release the previous one.
 */
const loaded = new Map<string, unknown>()

function getEngine(spec: SherpaSpec): unknown {
  const hit = loaded.get(spec.id)
  if (hit) return hit

  // Only the current one is kept: two half-gigabyte models in memory is already a lot.
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

/** Recognise one chunk, with a streaming model or an ordinary one. */
function decodeChunk(spec: SherpaSpec, samples: Float32Array, sampleRate: number): string {
  const engine = getEngine(spec)
  if (spec.streaming) {
    const online = engine as OnlineEngine
    const stream = online.createStream()
    stream.acceptWaveform({ sampleRate, samples })
    // There is nothing left to say: the chunk has ended, so the remainder can be collected.
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
 * Words with evenly spread timestamps.
 *
 * The model returns text with no timing, and further down the pipeline words
 * have to be laid out by speaker. They are spread over the length of the chunk
 * in proportion to their character count: more accurate than dividing equally,
 * and good enough to match against the voice separation segments.
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
 * Cutting into chunks in memory.
 *
 * Cutting is mandatory: half an hour of recording handed to the model whole
 * takes the process down with a native crash and no message at all. The
 * boundary is looked for at the nearest quiet point, so as not to break
 * mid-word, but if there is no silence we cut by time: a spoilt seam beats a
 * failed transcription.
 */
function chunkSamples(
  samples: Float32Array,
  sampleRate: number,
  chunkSeconds: number
): { from: number; to: number }[] {
  const window = Math.round(sampleRate * chunkSeconds)
  if (samples.length <= window) return [{ from: 0, to: samples.length }]

  // The quiet point is looked for in the last ten seconds of the chunk.
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
    // A copy rather than a subarray: the native layer must not see someone else's buffer.
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

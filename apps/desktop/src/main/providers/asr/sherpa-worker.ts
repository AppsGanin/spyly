import { t } from '@spyly/core'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Word } from '@spyly/core'
import { readWavPcm16 } from '../../audio/wav.js'
import { specById, type SherpaSpec } from './sherpa-specs.js'
import { WINDOW_MAX_SEC, joinWindows, windowsFromSpeech, wordsFromTokens, type Span } from './voice-windows.js'

/**
 * Transcription with sherpa-onnx models in a separate process.
 *
 * The library computes synchronously, one stretch of audio at a time.
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
  /** The speech detector, for the models that are cut at the pauses. */
  vadPath?: string
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

/** What a model says about one stretch: the text, and for some models the pieces it is made of. */
interface Decoded {
  text?: string
  tokens?: string[]
  timestamps?: number[]
}

interface OfflineEngine {
  createStream(): { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void }
  decode(stream: unknown): void
  getResult(stream: unknown): Decoded
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
function decodeChunk(spec: SherpaSpec, samples: Float32Array, sampleRate: number): Decoded {
  const engine = getEngine(spec)
  if (spec.streaming) {
    const online = engine as OnlineEngine
    const stream = online.createStream()
    stream.acceptWaveform({ sampleRate, samples })
    // There is nothing left to say: the chunk has ended, so the remainder can be collected.
    stream.inputFinished()
    while (online.isReady(stream)) online.decode(stream)
    return { text: (online.getResult(stream).text ?? '').trim() }
  }

  const offline = engine as OfflineEngine
  const stream = offline.createStream()
  stream.acceptWaveform({ sampleRate, samples })
  offline.decode(stream)
  return offline.getResult(stream)
}

/**
 * Words with evenly spread timestamps.
 *
 * Parakeet and Nemotron return text with no timing here, and further down the
 * pipeline words have to be laid out by speaker. They are spread over the
 * length of the chunk in proportion to their character count: more accurate
 * than dividing equally, and good enough to match against the voice separation
 * segments.
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


interface VadEngine {
  acceptWaveform(samples: Float32Array): void
  flush(): void
  isEmpty(): boolean
  front(enableExternalBuffer?: boolean): { samples: Float32Array; start: number }
  pop(): void
}

/**
 * Where in the recording someone is speaking.
 *
 * A pause shorter than 0.6 seconds does not end a phrase. Measured on a real
 * recording against 0.3: the shorter one cut "Мише" off from its sentence so
 * that it came back as "Миша", and lost "скажем так" altogether.
 */
function speechPhrases(samples: Float32Array, sampleRate: number, vadPath: string): Span[] {
  const { Vad } = require('sherpa-onnx-node') as { Vad: new (config: unknown, bufferSeconds: number) => VadEngine }
  const windowSize = 512
  const vad = new Vad(
    {
      sileroVad: {
        model: vadPath,
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.6,
        windowSize,
        // No phrase longer than a window: the detector cuts a monologue at its
        // quietest point, which is better than us cutting it at a wall clock.
        maxSpeechDuration: WINDOW_MAX_SEC
      },
      sampleRate,
      numThreads: 1,
      debug: false
    },
    WINDOW_MAX_SEC * 3
  )

  const phrases: Span[] = []
  const collect = (): void => {
    while (!vad.isEmpty()) {
      // A copy: by default the phrase points straight into the library's own
      // memory, and Electron refuses such a buffer with "External buffers are
      // not allowed" — plain Node takes it, so only the application fails.
      const phrase = vad.front(false)
      // Only where it is: the sound itself is cut from the recording later, so
      // an hour of speech is not held in memory twice.
      phrases.push({ start: phrase.start / sampleRate, end: (phrase.start + phrase.samples.length) / sampleRate })
      vad.pop()
    }
  }
  for (let at = 0; at + windowSize <= samples.length; at += windowSize) {
    vad.acceptWaveform(samples.subarray(at, at + windowSize))
    collect()
  }
  vad.flush()
  collect()
  return phrases
}

/** A model that only hears phrases: windows cut at the pauses, words timed by the model. */
function recogniseByVoice(spec: SherpaSpec, job: AsrJob, samples: Float32Array, sampleRate: number): Word[] {
  if (!job.vadPath) throw new Error(t('нет детектора речи для {model}', { model: spec.name }))
  const windows = windowsFromSpeech(speechPhrases(samples, sampleRate, job.vadPath))

  const recognised: Word[][] = []
  for (const [index, window] of windows.entries()) {
    const from = Math.floor(window.start * sampleRate)
    const to = Math.min(samples.length, Math.ceil(window.end * sampleRate))
    // A copy rather than a subarray: the native layer must not see someone else's buffer.
    const result = decodeChunk(spec, samples.slice(from, to), sampleRate)
    const text = (result.text ?? '').trim()
    if (text) {
      const start = from / sampleRate
      const end = to / sampleRate
      recognised.push(
        wordsFromTokens(result.tokens ?? [], result.timestamps ?? [], start, end) ?? spreadWords(text, start, end)
      )
    }
    process.parentPort?.postMessage({ type: 'progress', value: (index + 1) / windows.length })
  }
  return joinWindows(recognised)
}

/** A model that takes long stretches: fixed chunks, words spread over each. */
function recogniseByTime(spec: SherpaSpec, seconds: number, samples: Float32Array, sampleRate: number): Word[] {
  const pieces = chunkSamples(samples, sampleRate, seconds)
  const words: Word[] = []
  for (const [index, piece] of pieces.entries()) {
    // A copy rather than a subarray: the native layer must not see someone else's buffer.
    const slice = samples.slice(piece.from, piece.to)
    if (slice.length === 0) continue
    const text = (decodeChunk(spec, slice, sampleRate).text ?? '').trim()
    if (text) words.push(...spreadWords(text, piece.from / sampleRate, piece.to / sampleRate))
    process.parentPort?.postMessage({ type: 'progress', value: (index + 1) / pieces.length })
  }
  return words
}

async function run(job: AsrJob): Promise<AsrReply> {
  const spec = specById(job.specId)
  if (!spec) return { type: 'error', message: t('неизвестная модель: {job_specId}', { job_specId: job.specId }) }
  modelsRoot = job.modelsDir

  const { samples, sampleRate } = await readWavPcm16(job.wavPath)
  if (samples.length === 0) return { type: 'done', words: [] }

  const words =
    spec.cut.by === 'voice'
      ? recogniseByVoice(spec, job, samples, sampleRate)
      : recogniseByTime(spec, spec.cut.seconds, samples, sampleRate)
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

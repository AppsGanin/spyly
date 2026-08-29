import { releaseSentence, type TrackId } from '@spyly/core'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { modelsDir } from './models.js'

/**
 * Live transcription with a streaming model.
 *
 * Cutting into chunks at pauses gives text a whole phrase late: while a person
 * speaks there is nothing to show, and on a monologue the wait reaches ten
 * seconds. A streaming model works differently, taking audio continuously and
 * refining what has been said every 320 ms, so words appear almost at once and
 * are extended as speech goes on.
 *
 * Accuracy is secondary here: this is a draft, replaced in full after the
 * recording stops by a complete Whisper pass over the file.
 */

const MODEL_DIR = 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11'
const SAMPLE_RATE = 16000

/** The model's step: shorter and there is nothing to compute, longer and latency grows. */
const STEP_SAMPLES = Math.round(SAMPLE_RATE * 0.32)

/** This much silence in a row counts as the end of a phrase. */
const TRAILING_SILENCE_SEC = 0.8
/** Even without a pause a phrase has to be closed, or it grows without end. */
const MAX_UTTERANCE_SEC = 25

interface OnlineStreamHandle {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
  inputFinished(): void
}

interface OnlineEngine {
  createStream(): OnlineStreamHandle
  isReady(stream: OnlineStreamHandle): boolean
  decode(stream: OnlineStreamHandle): void
  isEndpoint(stream: OnlineStreamHandle): boolean
  reset(stream: OnlineStreamHandle): void
  getResult(stream: OnlineStreamHandle): { text?: string }
}

export interface LiveUpdate {
  /** The whole text of the phrase from its start. */
  text: string
  /** The phrase is finished; the text will not change any more. */
  final: boolean
  start: number
  end: number
}

let engine: OnlineEngine | null = null

export function modelPathForLive(): string {
  return path.join(modelsDir(), MODEL_DIR)
}

export function isLiveModelReady(): boolean {
  const dir = modelPathForLive()
  return ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].every((f) =>
    existsSync(path.join(dir, f))
  )
}

function getEngine(): OnlineEngine {
  if (engine) return engine
  const dir = modelPathForLive()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require('sherpa-onnx-node') as {
    OnlineRecognizer: new (config: unknown) => OnlineEngine
  }
  engine = new sherpa.OnlineRecognizer({
    modelConfig: {
      tokens: path.join(dir, 'tokens.txt'),
      transducer: {
        encoder: path.join(dir, 'encoder.int8.onnx'),
        decoder: path.join(dir, 'decoder.int8.onnx'),
        joiner: path.join(dir, 'joiner.int8.onnx')
      },
      numThreads: 2,
      provider: 'cpu',
      debug: false
    },
    // The engine decides where a phrase ends itself, by silence and by length.
    // Cutting it up ourselves would only get in the way: the model sees the
    // boundaries better than an energy threshold does.
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: TRAILING_SILENCE_SEC,
    rule3MinUtteranceLength: MAX_UTTERANCE_SEC
  })
  return engine
}

/**
 * Warm the model up in advance.
 *
 * Loading takes seconds, and without warming up they would land on the first
 * words of a conversation, exactly where the text is needed most.
 */
export function warmLiveModel(): void {
  if (!isLiveModelReady()) return
  getEngine()
}

/** Release the model: no reason to hold it in memory between recordings. */
export function releaseLiveModel(): void {
  engine = null
}

/**
 * The stream for one track.
 *
 * Emits an update for every chunk taken in: the current text of the phrase and
 * whether the phrase has ended. Until it has, the text can change, as the model
 * refines the beginning once it hears what follows.
 */
export class LiveTranscriber {
  private stream: OnlineStreamHandle
  private readonly recognizer: OnlineEngine
  private fedSamples = 0
  private segmentStart = 0
  private lastText = ''
  /** How many characters of the current result have already gone out as finished phrases. */
  private released = 0
  /** Audio arrives in 32 ms frames; the model computes in steps of 320 ms. */
  private waiting: Float32Array[] = []
  private waitingLength = 0

  constructor(readonly track: TrackId) {
    this.recognizer = getEngine()
    this.stream = this.recognizer.createStream()
  }

  push(samples: Float32Array): LiveUpdate | null {
    // Running recognition on every frame is pointless: it gives no result of its
    // own before the end of a step, while parsing the answer and checking for the
    // end of a phrase cost noticeably more than the computation itself.
    this.waiting.push(new Float32Array(samples))
    this.waitingLength += samples.length
    if (this.waitingLength < STEP_SAMPLES) return null

    const batch = new Float32Array(this.waitingLength)
    let offset = 0
    for (const piece of this.waiting) {
      batch.set(piece, offset)
      offset += piece.length
    }
    this.waiting = []
    this.waitingLength = 0
    return this.feed(batch)
  }

  private feed(samples: Float32Array): LiveUpdate | null {
    const at = this.fedSamples / SAMPLE_RATE
    this.fedSamples += samples.length
    const now = this.fedSamples / SAMPLE_RATE

    this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)

    const whole = (this.recognizer.getResult(this.stream).text ?? '').trim()
    const ended = this.recognizer.isEndpoint(this.stream)
    // Sentences already handed out are subtracted from the current result: the
    // model always returns the phrase whole, from its start.
    const text = whole.slice(this.released).trim()


    if (ended) {
      this.recognizer.reset(this.stream)
      const finished = text || this.lastText
      this.lastText = ''
      this.released = 0
      const start = this.segmentStart
      this.segmentStart = now
      if (!finished) return null
      return { text: finished, final: true, start, end: now }
    }

    // An empty result at the start of a phrase is still silence, not speech.
    if (!text) {
      this.segmentStart = at
      return null
    }

    // A finished sentence is released on its own line: without that a monologue
    // would grow into one paragraph tens of seconds long, awkward to read.
    const ready = releaseSentence(whole, this.released)
    if (ready) {
      // The boundary time comes from the share of characters: the model will not say
      // it more precisely, and for a draft this is enough.
      const boundary =
        this.segmentStart + ((now - this.segmentStart) * ready.sentence.length) / text.length
      this.released = ready.released
      this.lastText = ''
      const start = this.segmentStart
      this.segmentStart = boundary
      return { text: ready.sentence, final: true, start, end: boundary }
    }

    if (text === this.lastText) return null
    this.lastText = text
    return { text, final: false, start: this.segmentStart, end: now }
  }

  /**
   * Close the stream and take the remainder.
   *
   * There can be two updates: the last finished phrase out of the tail not yet
   * heard, and whatever is left after it. One value will not do here; the result
   * of that final listen used to be discarded, and the last words went missing.
   */
  finish(): LiveUpdate[] {
    const out: LiveUpdate[] = []

    // A tail that did not reach a full step is the last words: they must not be lost.
    if (this.waitingLength > 0) {
      const batch = new Float32Array(this.waitingLength)
      let offset = 0
      for (const piece of this.waiting) {
        batch.set(piece, offset)
        offset += piece.length
      }
      this.waiting = []
      this.waitingLength = 0
      const update = this.feed(batch)
      // An unfinished update will be covered by the remainder below, while a
      // finished one is a phrase of its own and has to be handed out.
      if (update?.final) out.push(update)
    }

    this.stream.inputFinished()
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
    const whole = (this.recognizer.getResult(this.stream).text ?? '').trim()
    // Phrases handed out are subtracted: without that the tail repeated everything
    // already shown since the start of the stretch.
    const text = whole.slice(this.released).trim()
    if (text) {
      out.push({ text, final: true, start: this.segmentStart, end: this.fedSamples / SAMPLE_RATE })
    }
    return out
  }
}

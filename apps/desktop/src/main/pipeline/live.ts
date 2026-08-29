import type { TrackId } from '@spyly/core'

/** 32 ms at 16 kHz, the frame the energy is computed over. */
const FRAME = 512
const SAMPLE_RATE = 16000
/** The pause after which an utterance counts as finished. */
const SILENCE_TO_END_MS = 700
/** The longest a chunk may be, or a monologue would not show until the very end. */
const MAX_SEGMENT_SEC = 12
/** Bursts that are too short are knocks and clicks, not speech. */
const MIN_SEGMENT_SEC = 0.7
/** This much audio before speech starts is attached, so the first syllable is not cut off. */
const PREROLL_SEC = 0.25

/**
 * Cutting a stream into utterances by signal energy.
 *
 * A separate VAD model would be excessive here: the question is not "is there
 * speech at all" but "has the person finished", and a threshold over the noise
 * floor handles that without loading anything into memory.
 */
export class SpeechChunker {
  private buffer: Float32Array[] = []
  private bufferLength = 0
  private preroll: Float32Array[] = []
  private prerollLength = 0
  private speaking = false
  private silenceMs = 0
  private segmentSec = 0
  private noiseFloor = 0.004
  private offsetSec = 0
  private segmentStartSec = 0

  constructor(
    readonly track: TrackId,
    private readonly onSegment: (samples: Float32Array, startSec: number) => void
  ) {}

  push(chunk: Float32Array): void {
    for (let offset = 0; offset < chunk.length; offset += FRAME) {
      this.handleFrame(chunk.subarray(offset, Math.min(offset + FRAME, chunk.length)))
    }
  }

  private handleFrame(frame: Float32Array): void {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!
    const rms = Math.sqrt(sum / Math.max(1, frame.length))
    const frameSec = frame.length / SAMPLE_RATE
    this.offsetSec += frameSec

    // The noise floor adjusts slowly and only over silence: otherwise loud speech
    // raises the threshold and the phrases after it start going missing.
    if (!this.speaking) {
      this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005
    }
    const threshold = Math.max(this.noiseFloor * 3, 0.008)

    if (rms > threshold) {
      if (!this.speaking) {
        this.speaking = true
        this.segmentSec = 0
        this.segmentStartSec = Math.max(0, this.offsetSec - frameSec - PREROLL_SEC)
        this.buffer = [...this.preroll]
        this.bufferLength = this.prerollLength
      }
      this.silenceMs = 0
      this.append(frame)
      this.segmentSec += frameSec
      if (this.segmentSec >= MAX_SEGMENT_SEC) this.flush()
      return
    }

    if (this.speaking) {
      // Short pauses inside a phrase stay in the chunk: without them speech is torn
      // into separate words and the transcript comes out ragged.
      this.append(frame)
      this.segmentSec += frameSec
      this.silenceMs += frameSec * 1000
      if (this.silenceMs >= SILENCE_TO_END_MS) this.flush()
      return
    }

    this.rememberPreroll(frame)
  }

  private append(frame: Float32Array): void {
    this.buffer.push(new Float32Array(frame))
    this.bufferLength += frame.length
  }

  private rememberPreroll(frame: Float32Array): void {
    this.preroll.push(new Float32Array(frame))
    this.prerollLength += frame.length
    const limit = PREROLL_SEC * SAMPLE_RATE
    while (this.prerollLength > limit && this.preroll.length > 1) {
      const dropped = this.preroll.shift()!
      this.prerollLength -= dropped.length
    }
  }

  /** Hand out what has accumulated; also called when a recording stops. */
  flush(): void {
    const wasSpeaking = this.speaking
    this.speaking = false
    this.silenceMs = 0
    const length = this.bufferLength
    const chunks = this.buffer
    const startSec = this.segmentStartSec
    this.buffer = []
    this.bufferLength = 0
    this.preroll = []
    this.prerollLength = 0

    if (!wasSpeaking || length < MIN_SEGMENT_SEC * SAMPLE_RATE) return

    const joined = new Float32Array(length)
    let offset = 0
    for (const piece of chunks) {
      joined.set(piece, offset)
      offset += piece.length
    }
    this.onSegment(joined, startSec)
  }
}

/** A WAV in memory: whisper-server takes a file, not raw samples. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44)
  const dataBytes = samples.length * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)

  const body = Buffer.alloc(dataBytes)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!))
    body.writeInt16LE(Math.round(value * 32767), i * 2)
  }
  return Buffer.concat([header, body])
}

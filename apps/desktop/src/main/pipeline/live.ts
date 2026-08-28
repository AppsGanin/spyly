import type { TrackId } from '@spyly/core'

/** 32 мс при 16 кГц — кадр, на котором считается энергия. */
const FRAME = 512
const SAMPLE_RATE = 16000
/** Пауза, после которой реплика считается законченной. */
const SILENCE_TO_END_MS = 700
/** Максимальная длина куска: иначе монолог не покажется до самого конца. */
const MAX_SEGMENT_SEC = 12
/** Слишком короткие всплески — это стуки и клики, а не речь. */
const MIN_SEGMENT_SEC = 0.7
/** Столько звука до начала речи прицепляем, чтобы не срезать первый слог. */
const PREROLL_SEC = 0.25

/**
 * Нарезка потока на реплики по энергии сигнала.
 *
 * Отдельная модель VAD здесь была бы лишней: задача не «есть ли речь вообще»,
 * а «человек договорил или ещё нет», и порог по шумовому полу с этим
 * справляется, ничего не загружая в память.
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

    // Шумовой пол подстраивается медленно и только по тишине: иначе громкая
    // речь поднимет порог, и следующие фразы начнут теряться.
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
      // Короткие паузы внутри фразы оставляем в куске: без них речь рвётся
      // на отдельные слова и расшифровка получается рваной.
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

  /** Отдать накопленное наружу; вызывается и при остановке записи. */
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

/** WAV в памяти: whisper-server принимает файл, а не сырые сэмплы. */
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

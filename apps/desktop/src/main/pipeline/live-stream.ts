import { releaseSentence, type TrackId } from '@spyly/core'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { modelsDir } from './models.js'

/**
 * Живая расшифровка потоковой моделью.
 *
 * Нарезка на куски по паузам даёт текст с опозданием на всю фразу: пока
 * человек говорит, показывать нечего, а на монологе ожидание доходит до
 * десятка секунд. Потоковая модель устроена иначе — она принимает звук
 * непрерывно и после каждых 320 мс уточняет уже сказанное, поэтому слова
 * появляются почти сразу и дописываются по ходу речи.
 *
 * Точность здесь второстепенна: это черновик, который после остановки записи
 * целиком заменяется полным проходом Whisper по файлу.
 */

const MODEL_DIR = 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11'
const SAMPLE_RATE = 16000

/** Шаг модели: короче считать нечего, длиннее — растёт задержка. */
const STEP_SAMPLES = Math.round(SAMPLE_RATE * 0.32)

/** Столько тишины подряд считается концом фразы. */
const TRAILING_SILENCE_SEC = 0.8
/** Даже без паузы фразу пора закрывать: иначе она растёт без конца. */
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
  /** Текст фразы целиком с её начала. */
  text: string
  /** Фраза закончена — дальше текст меняться не будет. */
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
    // Конец фразы движок определяет сам — по тишине и по длине. Своя нарезка
    // здесь только мешала бы: модель видит границы точнее, чем порог энергии.
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: TRAILING_SILENCE_SEC,
    rule3MinUtteranceLength: MAX_UTTERANCE_SEC
  })
  return engine
}

/**
 * Прогреть модель заранее.
 *
 * Загрузка занимает секунды, и без прогрева они пришлись бы на первые слова
 * разговора — ровно на то место, где текст нужнее всего.
 */
export function warmLiveModel(): void {
  if (!isLiveModelReady()) return
  getEngine()
}

/** Освободить модель: между записями держать её в памяти незачем. */
export function releaseLiveModel(): void {
  engine = null
}

/**
 * Поток одной дорожки.
 *
 * Отдаёт обновление на каждый принятый кусок: текущий текст фразы и признак
 * того, что фраза закончилась. Пока фраза не закончена, текст может меняться —
 * модель уточняет начало, услышав продолжение.
 */
export class LiveTranscriber {
  private stream: OnlineStreamHandle
  private readonly recognizer: OnlineEngine
  private fedSamples = 0
  private segmentStart = 0
  private lastText = ''
  /** Сколько символов текущего результата уже отдано законченными фразами. */
  private released = 0
  /** Звук приходит кадрами по 32 мс — модель считает шагами по 320 мс. */
  private waiting: Float32Array[] = []
  private waitingLength = 0

  constructor(readonly track: TrackId) {
    this.recognizer = getEngine()
    this.stream = this.recognizer.createStream()
  }

  push(samples: Float32Array): LiveUpdate | null {
    // Гонять распознавание на каждый кадр незачем: своего результата раньше
    // конца шага оно не даст, а разбор ответа и проверка конца фразы стоят
    // заметно дороже самого счёта.
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
    // Уже отданные предложения из текущего результата вычитаем: модель всегда
    // возвращает фразу целиком с её начала.
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

    // Пустой результат в начале фразы — это ещё тишина, а не речь.
    if (!text) {
      this.segmentStart = at
      return null
    }

    // Договорённое предложение отпускаем отдельной строкой: без этого монолог
    // рос бы одним абзацем на десятки секунд, который неудобно читать.
    const ready = releaseSentence(whole, this.released)
    if (ready) {
      // Время границы — по доле символов: точнее модель не скажет, а для
      // черновика этого достаточно.
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
   * Закрыть поток и забрать остаток.
   *
   * Обновлений может быть два: последняя договорённая фраза из недослушанного
   * хвоста и то, что осталось после неё. Одним значением тут не обойтись —
   * раньше результат дослушивания отбрасывался, и последние слова пропадали.
   */
  finish(): LiveUpdate[] {
    const out: LiveUpdate[] = []

    // Недобранный до шага хвост — это последние слова: их терять нельзя.
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
      // Незаконченное обновление перекроется остатком ниже, а законченное —
      // это отдельная фраза, и её надо отдать.
      if (update?.final) out.push(update)
    }

    this.stream.inputFinished()
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
    const whole = (this.recognizer.getResult(this.stream).text ?? '').trim()
    // Отданные фразы вычитаем: без этого хвост повторял всё, что уже показано
    // с начала отрезка.
    const text = whole.slice(this.released).trim()
    if (text) {
      out.push({ text, final: true, start: this.segmentStart, end: this.fedSamples / SAMPLE_RATE })
    }
    return out
  }
}

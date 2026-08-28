import { t } from '@spyly/core'
import { createWriteStream, existsSync, statSync, type WriteStream } from 'node:fs'
import { open, writeFile, type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const HEADER_BYTES = 44

/** Заголовок WAV с нулевыми длинами — их допишем по ходу записи. */
function buildHeader(sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  header.write('RIFF', 0)
  header.writeUInt32LE(0, 4) // размер файла минус 8 — патчится
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(0, 40) // размер данных — патчится
  return header
}

export interface WavWriterOptions {
  path: string
  sampleRate?: number
  channels?: number
  /** Как часто дописывать длины в заголовок. */
  headerFlushMs?: number
  /** Дописывать в существующий файл, а не начинать заново. */
  append?: boolean
}

/**
 * Потоковая запись WAV с периодическим обновлением заголовка.
 *
 * Обычный WAV-писатель проставляет длины в самом конце, поэтому падение на
 * сороковой минуте оставляет файл, который не откроет ни один плеер. Здесь
 * длины дописываются каждые несколько секунд, и запись переживает краш.
 */
export class WavWriter {
  private stream: WriteStream
  private handle: FileHandle | null = null
  private headerTimer: NodeJS.Timeout | null = null
  private bytesWritten = 0
  private closed = false
  private readonly sampleRate: number
  private readonly channels: number

  constructor(private readonly options: WavWriterOptions) {
    this.sampleRate = options.sampleRate ?? 16000
    this.channels = options.channels ?? 1

    // Продолжение записи дописывает звук в конец существующего файла, а не
    // заводит новый: разговор, прерванный и возобновлённый, для человека
    // остаётся одним разговором.
    const existing = options.append && existsSync(options.path) ? statSync(options.path).size : 0
    if (existing > HEADER_BYTES) {
      this.bytesWritten = existing - HEADER_BYTES
      this.stream = createWriteStream(options.path, { flags: 'r+', start: existing })
    } else {
      this.stream = createWriteStream(options.path)
      this.stream.write(buildHeader(this.sampleRate, this.channels, 16))
    }
  }

  async open(): Promise<void> {
    // Файл создаёт поток записи, и делает это асинхронно. Открыть второй
    // дескриптор для правки заголовка можно только после того, как файл
    // действительно появился, иначе получаем ENOENT на первой же записи.
    await new Promise<void>((resolve, reject) => {
      if ((this.stream as { pending?: boolean }).pending === false) {
        resolve()
        return
      }
      this.stream.once('ready', () => resolve())
      this.stream.once('error', reject)
    })
    this.handle = await open(this.options.path, 'r+')
    const interval = this.options.headerFlushMs ?? 5000
    this.headerTimer = setInterval(() => {
      void this.patchHeader()
    }, interval)
    this.headerTimer.unref?.()
  }

  /** Float32 в диапазоне [-1, 1] → 16-bit PCM. Клиппинг вместо переполнения. */
  writeFloat32(samples: Float32Array): void {
    if (this.closed) return
    const out = Buffer.alloc(samples.length * 2)
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]!))
      out.writeInt16LE(Math.round(v * 32767), i * 2)
    }
    this.bytesWritten += out.length
    this.stream.write(out)
  }

  /** Тишина заданной длины — чтобы дорожки не разъезжались при пропаже сэмплов. */
  writeSilence(seconds: number): void {
    if (this.closed || seconds <= 0) return
    const frames = Math.round(seconds * this.sampleRate)
    const out = Buffer.alloc(frames * this.channels * 2)
    this.bytesWritten += out.length
    this.stream.write(out)
  }

  get durationSec(): number {
    return this.bytesWritten / (this.sampleRate * this.channels * 2)
  }

  get byteLength(): number {
    return this.bytesWritten
  }

  private async patchHeader(): Promise<void> {
    const handle = this.handle
    if (!handle || this.closed) return
    const sizes = Buffer.alloc(4)
    try {
      sizes.writeUInt32LE(this.bytesWritten + HEADER_BYTES - 8, 0)
      await handle.write(sizes, 0, 4, 4)
      sizes.writeUInt32LE(this.bytesWritten, 0)
      await handle.write(sizes, 0, 4, 40)
    } catch {
      // Файл могли удалить из-под нас — запись важнее точности заголовка.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.headerTimer) clearInterval(this.headerTimer)
    await new Promise<void>((resolve) => this.stream.end(resolve))
    await this.patchHeaderOnClose()
  }

  private async patchHeaderOnClose(): Promise<void> {
    const handle = this.handle ?? (await open(this.options.path, 'r+').catch(() => null))
    if (!handle) return
    const sizes = Buffer.alloc(4)
    try {
      sizes.writeUInt32LE(this.bytesWritten + HEADER_BYTES - 8, 0)
      await handle.write(sizes, 0, 4, 4)
      sizes.writeUInt32LE(this.bytesWritten, 0)
      await handle.write(sizes, 0, 4, 40)
    } finally {
      await handle.close().catch(() => {})
      this.handle = null
    }
  }
}

/** Починить WAV, оставшийся от упавшей записи: длины берём из фактического размера. */
export async function repairWav(path: string): Promise<boolean> {
  const handle = await open(path, 'r+').catch(() => null)
  if (!handle) return false
  try {
    const stat = await handle.stat()
    if (stat.size <= HEADER_BYTES) return false
    const dataBytes = stat.size - HEADER_BYTES
    const buf = Buffer.alloc(4)
    buf.writeUInt32LE(stat.size - 8, 0)
    await handle.write(buf, 0, 4, 4)
    buf.writeUInt32LE(dataBytes, 0)
    await handle.write(buf, 0, 4, 40)
    return true
  } finally {
    await handle.close().catch(() => {})
  }
}

export interface DecodedWav {
  sampleRate: number
  channels: number
  samples: Float32Array
}

/**
 * Чтение WAV с 16-битным PCM.
 *
 * Свой разбор, а не readWave из sherpa-onnx: аддон отдаёт Float32Array поверх
 * внешнего буфера, а Electron такие буферы запрещает
 * («External buffers are not allowed»). Формат мы пишем сами, так что разбор
 * тривиальный.
 */
export async function readWavPcm16(file: string): Promise<DecodedWav> {
  const { readFile } = await import('node:fs/promises')
  const buf = await readFile(file)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(t('не похоже на WAV: {file}', { file: file }))
  }

  let offset = 12
  let sampleRate = 16000
  let channels = 1
  let bitsPerSample = 16
  let dataStart = -1
  let dataLength = 0

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10)
      sampleRate = buf.readUInt32LE(offset + 12)
      bitsPerSample = buf.readUInt16LE(offset + 22)
    } else if (id === 'data') {
      dataStart = offset + 8
      dataLength = size
      break
    }
    offset += 8 + size + (size % 2)
  }

  if (dataStart < 0) throw new Error(t('в WAV нет данных: {file}', { file: file }))
  if (bitsPerSample !== 16) throw new Error(t('поддерживается только 16-битный PCM, здесь {bitsPerSample}', { bitsPerSample: bitsPerSample }))

  // Длина из заголовка может быть меньше фактической, если запись оборвалась
  // до последней правки заголовка — берём то, что реально есть на диске.
  const available = Math.max(0, Math.min(dataLength || buf.length - dataStart, buf.length - dataStart))
  const frames = Math.floor(available / 2 / Math.max(1, channels))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * 2 * channels) / 32768
  }
  return { sampleRate, channels, samples }
}

/**
 * Свести дорожки в одну для прослушивания.
 *
 * Раздельные дорожки нужны расшифровке, а человеку удобнее слушать разговор
 * целиком. Микс делается по требованию и кладётся рядом с записью.
 */
export async function mixTracks(micPath: string, systemPath: string, outPath: string): Promise<void> {
  const parts: DecodedWav[] = []
  for (const file of [micPath, systemPath]) {
    if (existsSync(file)) parts.push(await readWavPcm16(file))
  }
  if (parts.length === 0) throw new Error(t('нет дорожек для сведения'))

  const sampleRate = parts[0]!.sampleRate
  const length = Math.max(...parts.map((p) => p.samples.length))
  const mixed = new Float32Array(length)

  /*
   * Пока говорит собеседник, микрофон приглушаем.
   *
   * Его голос звучит из динамиков, и микрофон записывает его следом. В простой
   * сумме он оказывается дважды, со сдвигом в десятки миллисекунд — это и есть
   * то самое эхо, из-за которого запись неприятно слушать.
   *
   * Приглушение по громкости — приём грубый, зато надёжный: он не трогает
   * исходные дорожки, а нужен только для сведённой версии, которую слушают.
   */
  const [mic, system] = [
    existsSync(micPath) ? parts[0] : undefined,
    existsSync(systemPath) ? parts[existsSync(micPath) ? 1 : 0] : undefined
  ]

  if (mic && system) {
    // Окно 20 мс: короче — слышны рывки громкости, длиннее — приглушается
    // и то, что человек сказал в паузе собеседника.
    const window = Math.round(sampleRate * 0.02)
    const duckTo = 0.25

    for (let start = 0; start < length; start += window) {
      const end = Math.min(start + window, length)

      let systemEnergy = 0
      for (let i = start; i < end && i < system.samples.length; i++) {
        systemEnergy += system.samples[i]! * system.samples[i]!
      }
      const systemLoud = Math.sqrt(systemEnergy / Math.max(1, end - start)) > 0.02
      const micGain = systemLoud ? duckTo : 1

      for (let i = start; i < end; i++) {
        const own = i < mic.samples.length ? mic.samples[i]! * micGain : 0
        const remote = i < system.samples.length ? system.samples[i]! : 0
        mixed[i] = own + remote
      }
    }
  } else {
    for (const part of parts) {
      for (let i = 0; i < part.samples.length; i++) mixed[i] = mixed[i]! + part.samples[i]!
    }
  }
  // Нормализуем только если сумма вышла за пределы: тихий разговор не должен
  // становиться громче, чем был.
  let peak = 0
  for (let i = 0; i < mixed.length; i++) peak = Math.max(peak, Math.abs(mixed[i]!))
  const gain = peak > 1 ? 1 / peak : 1

  const writer = new WavWriter({ path: outPath, sampleRate, channels: 1, headerFlushMs: 60_000 })
  await writer.open()
  const CHUNK = 32768
  for (let offset = 0; offset < mixed.length; offset += CHUNK) {
    const slice = mixed.subarray(offset, Math.min(offset + CHUNK, mixed.length))
    if (gain !== 1) for (let i = 0; i < slice.length; i++) slice[i] = slice[i]! * gain
    writer.writeFloat32(slice)
  }
  await writer.close()
}

/**
 * Громкость дорожки окнами.
 *
 * Нужна, чтобы отличить свою речь от эха динамиков: сравнивать дорожки по
 * тексту бесполезно, а по громкости — надёжно.
 */
export function levelWindows(
  samples: Float32Array,
  sampleRate: number,
  windowSec = 0.25
): { start: number; end: number; rms: number }[] {
  const size = Math.max(1, Math.round(sampleRate * windowSec))
  const out: { start: number; end: number; rms: number }[] = []
  for (let at = 0; at < samples.length; at += size) {
    const to = Math.min(at + size, samples.length)
    let energy = 0
    for (let i = at; i < to; i++) energy += samples[i]! * samples[i]!
    out.push({
      start: at / sampleRate,
      end: to / sampleRate,
      rms: Math.sqrt(energy / Math.max(1, to - at))
    })
  }
  return out
}

/** Есть ли в дорожке речь вообще — дешёвая проверка по энергии. */
export function speechSeconds(samples: Float32Array, sampleRate = 16000): number {
  const frame = 512
  let noiseFloor = 0.004
  let speech = 0
  for (let offset = 0; offset + frame <= samples.length; offset += frame) {
    let sum = 0
    for (let i = 0; i < frame; i++) {
      const v = samples[offset + i]!
      sum += v * v
    }
    const rms = Math.sqrt(sum / frame)
    if (rms <= Math.max(noiseFloor * 3, 0.008)) {
      noiseFloor = noiseFloor * 0.995 + rms * 0.005
    } else {
      speech += frame / sampleRate
    }
  }
  return speech
}

export interface AudioChunk {
  path: string
  offsetSec: number
}

/**
 * Резка записи на куски по тишине.
 *
 * Нужна для автоопределения языка: whisper решает, на каком языке говорят,
 * один раз на файл. Режем в паузах и только рядом с целевой длиной — рвать
 * посреди фразы нельзя, иначе распознавание на стыке портится.
 */
export async function splitOnSilence(
  file: string,
  targetSec = 120,
  outDir = os.tmpdir()
): Promise<AudioChunk[]> {
  const { samples, sampleRate } = await readWavPcm16(file)
  const total = samples.length / sampleRate
  if (total <= targetSec * 1.5) return []

  // Окно 40 мс: короче — шум, длиннее — проскакивают короткие паузы.
  const window = Math.round(sampleRate * 0.04)
  const quiet: boolean[] = []
  for (let i = 0; i + window <= samples.length; i += window) {
    let sum = 0
    for (let j = i; j < i + window; j++) sum += samples[j]! * samples[j]!
    quiet.push(Math.sqrt(sum / window) < 0.01)
  }

  // Пауза — не меньше полусекунды подряд.
  const minQuiet = Math.round(0.5 / 0.04)
  const pauses: number[] = []
  let run = 0
  for (let i = 0; i < quiet.length; i++) {
    if (quiet[i]) {
      run++
      continue
    }
    if (run >= minQuiet) pauses.push(((i - run / 2) * window) / sampleRate)
    run = 0
  }

  // Слишком короткий кусок распознавать бессмысленно: языку не на чем
  // определиться. Считаем от предыдущего разреза, а не от начала файла.
  const minChunk = Math.max(5, targetSec / 4)

  const cuts: number[] = []
  let next = targetSec
  while (next < total - targetSec / 2) {
    // Ближайшая пауза к желаемой границе, но не дальше половины куска от неё:
    // если разговор идёт сплошняком, лучше не резать вовсе.
    let best = -1
    for (const pause of pauses) {
      if (pause <= (cuts[cuts.length - 1] ?? 0) + minChunk) continue
      if (Math.abs(pause - next) > targetSec / 2) continue
      if (best < 0 || Math.abs(pause - next) < Math.abs(best - next)) best = pause
    }
    if (best < 0) break
    cuts.push(best)
    next = best + targetSec
  }

  if (cuts.length === 0) return []

  const bounds = [0, ...cuts, total]
  const chunks: AudioChunk[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = Math.round(bounds[i]! * sampleRate)
    const to = Math.round(bounds[i + 1]! * sampleRate)
    const slice = samples.subarray(from, to)
    const out = path.join(outDir, `spyly-part-${path.basename(file, '.wav')}-${i}-${process.pid}.wav`)
    await writeWavPcm16(out, slice, sampleRate)
    chunks.push({ path: out, offsetSec: bounds[i]! })
  }
  return chunks
}

/** Запись Float32 в 16-битный WAV — обратная операция к `readWavPcm16`. */
export async function writeWavPcm16(file: string, samples: Float32Array, sampleRate: number): Promise<void> {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!))
    data.writeInt16LE(Math.round(value * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
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
  header.writeUInt32LE(data.length, 40)
  await writeFile(file, Buffer.concat([header, data]))
}


/**
 * Замена промежутка тишиной.
 *
 * Используется, когда из записи нужно убрать лишнее. Именно тишина, а не
 * вырезание: укоротить файл значит сдвинуть все последующие таймкоды, отметки
 * и уже собранный конспект — а задача «здесь не должно быть слышно» решается
 * и так.
 */
export async function silenceRange(file: string, fromSec: number, toSec: number): Promise<number> {
  const { samples, sampleRate } = await readWavPcm16(file)
  const from = Math.max(0, Math.floor(fromSec * sampleRate))
  const to = Math.min(samples.length, Math.ceil(toSec * sampleRate))
  if (to <= from) return 0
  samples.fill(0, from, to)
  await writeWavPcm16(file, samples, sampleRate)
  return (to - from) / sampleRate
}

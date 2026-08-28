import { t } from '@spyly/core'
/**
 * Захват звука средствами Chromium — для Windows и Linux.
 *
 * На macOS этот путь нерабочий: `getDisplayMedia({ audio: 'loopback' })` там
 * отдаёт уже завершённый трек. Зато на Windows (WASAPI loopback) и Linux
 * (PipeWire через портал) он штатный, и нативный код не нужен.
 *
 * Звук приходит с частотой звуковой карты (44.1 или 48 кГц) и в стерео, а
 * распознаванию нужен моно 16 кГц — приводим прямо здесь, чтобы через границу
 * процессов шло вчетверо меньше данных.
 */
/** Кусок ~64 мс: чаще — лишние переходы между процессами, реже — заметная задержка. */
const CHUNK_SAMPLES = 1024

interface Track {
  stream: MediaStream
  context: AudioContext
  node: AudioWorkletNode
}

const tracks = new Map<'mic' | 'system', Track>()

async function attach(
  id: 'mic' | 'system',
  stream: MediaStream,
  onChunk: (id: 'mic' | 'system', samples: Float32Array) => void
): Promise<void> {
  const context = new AudioContext()
  // Файл лежит рядом с index.html: политика безопасности приложения не пускает
  // ни blob-, ни data-скрипты, а тихо не запустившийся обработчик даёт
  // идеально пустую запись — худший вид поломки.
  await context.audioWorklet.addModule(new URL('downsampler.js', document.baseURI).href)

  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'downsampler')
  let pending: number[] = []

  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    for (const value of event.data) pending.push(value)
    while (pending.length >= CHUNK_SAMPLES) {
      onChunk(id, new Float32Array(pending.splice(0, CHUNK_SAMPLES)))
    }
  }

  source.connect(node)
  // Без подключения к выходу обработчик в некоторых версиях Chromium не
  // вызывается вовсе; глушим громкость, чтобы звук не пошёл в динамики.
  const silence = context.createGain()
  silence.gain.value = 0
  node.connect(silence).connect(context.destination)

  tracks.set(id, { stream, context, node })
}

export interface CaptureRequest {
  mic: boolean
  system: boolean
  micDeviceId?: string
}

/**
 * Запуск захвата. Возвращает, что реально удалось открыть.
 *
 * Отказ одной дорожки не отменяет вторую: записать хотя бы свой голос лучше,
 * чем не записать ничего.
 */
export async function startCapture(
  request: CaptureRequest,
  onChunk: (id: 'mic' | 'system', samples: Float32Array) => void
): Promise<{ mic: boolean; system: boolean; errors: string[] }> {
  const errors: string[] = []
  let mic = false
  let system = false

  if (request.mic) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: request.micDeviceId ? { exact: request.micDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      await attach('mic', stream, onChunk)
      mic = true
    } catch (error) {
      errors.push(t('микрофон: {why}', { why: error instanceof Error ? error.message : String(error) }))
    }
  }

  if (request.system) {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      })
      // Картинка нам не нужна — гасим её сразу, иначе Chromium продолжает
      // кодировать кадры и греет процессор всю запись.
      for (const video of stream.getVideoTracks()) {
        video.stop()
        stream.removeTrack(video)
      }
      if (stream.getAudioTracks().length === 0) {
        throw new Error(t('система не отдала звук'))
      }
      await attach('system', stream, onChunk)
      system = true
    } catch (error) {
      errors.push(t('системный звук: {why}', { why: error instanceof Error ? error.message : String(error) }))
    }
  }

  return { mic, system, errors }
}

export async function stopCapture(): Promise<void> {
  for (const [, track] of tracks) {
    track.node.port.onmessage = null
    track.node.disconnect()
    for (const media of track.stream.getTracks()) media.stop()
    await track.context.close().catch(() => undefined)
  }
  tracks.clear()
}

export function capturing(): boolean {
  return tracks.size > 0
}

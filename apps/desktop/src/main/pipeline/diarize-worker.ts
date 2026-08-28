import { createRequire } from 'node:module'
import { readWavPcm16 } from '../audio/wav.js'

/**
 * Разделение по голосам в отдельном процессе.
 *
 * Библиотека считает синхронно и целиком: на 130 секундах звука это семь секунд,
 * на часовой записи — минуты. В главном процессе такой вызов замораживает всё,
 * включая приём звука с микрофона, — а обработка прошлой записи вполне может
 * идти одновременно со следующей. Поэтому счёт живёт здесь и падение этого
 * процесса не уносит с собой запись.
 */

const require = createRequire(import.meta.url)

export interface DiarizeJob {
  wavPath: string
  segmentation: string
  embedding: string
  /** −1 значит «определить число говорящих самому». */
  numClusters: number
  threshold: number
}

export type DiarizeReply =
  | { ok: true; turns: { start: number; end: number; cluster: number }[] }
  | { ok: false; error: string }

interface Engine {
  process(samples: Float32Array): { start: number; end: number; speaker: number }[]
}

async function run(job: DiarizeJob): Promise<DiarizeReply> {
  const wave = await readWavPcm16(job.wavPath)
  if (wave.samples.length === 0) return { ok: true, turns: [] }

  const { OfflineSpeakerDiarization } = require('sherpa-onnx-node') as {
    OfflineSpeakerDiarization: new (config: unknown) => Engine
  }
  const engine = new OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: job.segmentation }, numThreads: 4 },
    embedding: { model: job.embedding, numThreads: 4 },
    clustering: { numClusters: job.numClusters, threshold: job.threshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })

  const turns = engine
    .process(wave.samples)
    .map((s) => ({ start: s.start, end: s.end, cluster: s.speaker }))
    .sort((a, b) => a.start - b.start)
  return { ok: true, turns }
}

process.parentPort?.on('message', (event: { data: DiarizeJob }) => {
  void run(event.data)
    .catch((error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error)
    }))
    .then((reply) => {
      process.parentPort?.postMessage(reply)
    })
})

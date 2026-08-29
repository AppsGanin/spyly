/**
 * Recognition models on the sherpa-onnx engine.
 *
 * Every non-Whisper model lives here: GigaAM, Parakeet, Nemotron. They are
 * built differently, one returning text whole, another working as a stream,
 * but from the pipeline's point of view they do the same thing, so their code
 * is shared.
 *
 * What they have in common: not one of them gives per-word timestamps. Further
 * down the pipeline words have to be laid out by speaker, so the times are
 * filled in here.
 */
interface SherpaSpec {
  id: string
  name: string
  dir: string
  /** A streaming model decodes as the audio arrives. */
  streaming: boolean
  /** One file (CTC) or three (transducer). */
  files: { model: string } | { encoder: string; decoder: string; joiner: string }
  language: string
  /**
   * The chunk length in seconds.
   *
   * Chosen by measurement: Parakeet brings the process down with a native crash
   * on two-minute chunks, GigaAM holds them. Chunks that are too small are bad
   * as well, as recognition loses words at the seams.
   */
  chunkSeconds: number
}

const SPECS: SherpaSpec[] = [
  {
    id: 'gigaam-v3-ru',
    name: 'GigaAM v3',
    dir: 'sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16',
    streaming: false,
    files: { model: 'model.int8.onnx' },
    language: 'ru',
    chunkSeconds: 120
  },
  {
    id: 'parakeet-tdt-v3',
    name: 'Parakeet TDT v3',
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    streaming: false,
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx' },
    language: 'multi',
    chunkSeconds: 30
  },
  {
    id: 'nemotron-3.5',
    name: 'Nemotron Speech 3.5',
    dir: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11',
    streaming: true,
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx' },
    language: 'multi',
    chunkSeconds: 120
  }
]

export const SHERPA_MODEL_IDS = SPECS.map((s) => s.id)

export function specById(id: string): SherpaSpec | null {
  return SPECS.find((s) => s.id === id) ?? null
}

export { SPECS }
export type { SherpaSpec }

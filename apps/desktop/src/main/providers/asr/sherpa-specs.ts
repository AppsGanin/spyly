/**
 * Recognition models on the sherpa-onnx engine.
 *
 * Every non-Whisper model lives here: GigaAM, Parakeet and Nemotron. They are
 * built differently, one returning text whole, another working as a stream,
 * but from the pipeline's point of view they do the same thing, so their code
 * is shared.
 */
interface SherpaSpec {
  id: string
  name: string
  dir: string
  /** A streaming model decodes as the audio arrives. */
  streaming: boolean
  /** One file (CTC) or three (transducer). */
  files: { model: string } | { encoder: string; decoder: string; joiner: string }
  /** The language it knows, or `multi`. A model for one language is not given another. */
  language: string
  /**
   * How a recording is cut before recognition.
   *
   * By time for the models that take long stretches, with the length chosen by
   * measurement: Parakeet brings the process down with a native crash on
   * two-minute chunks, and chunks that are too small lose words at the seams.
   * The words then have no times of their own and are spread over the chunk.
   *
   * By voice for a model that only hears phrases (see voice-windows.ts): the
   * cuts follow the pauses, and every word takes the model's own time.
   */
  cut: { by: 'time'; seconds: number } | { by: 'voice' }
}

const SPECS: SherpaSpec[] = [
  {
    id: 'gigaam-v3-ru',
    name: 'GigaAM v3',
    // The variant that puts in punctuation and capitals itself. MIT, like the
    // GigaAM repository: the licence file in this very archive says so.
    dir: 'sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16',
    streaming: false,
    files: { model: 'model.int8.onnx' },
    language: 'ru',
    cut: { by: 'voice' }
  },
  {
    id: 'parakeet-tdt-v3',
    name: 'Parakeet TDT v3',
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    streaming: false,
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx' },
    language: 'multi',
    cut: { by: 'time', seconds: 30 }
  },
  {
    id: 'nemotron-3.5',
    name: 'Nemotron Speech 3.5',
    dir: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11',
    streaming: true,
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx' },
    language: 'multi',
    cut: { by: 'time', seconds: 120 }
  }
]

export const SHERPA_MODEL_IDS = SPECS.map((s) => s.id)

export function specById(id: string): SherpaSpec | null {
  return SPECS.find((s) => s.id === id) ?? null
}

export { SPECS }
export type { SherpaSpec }

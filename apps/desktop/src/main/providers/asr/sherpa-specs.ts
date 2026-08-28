/**
 * Модели распознавания на движке sherpa-onnx.
 *
 * Здесь живут все не-Whisper модели: GigaAM, Parakeet, Nemotron. Они устроены
 * по-разному — одна отдаёт текст целиком, другая работает потоком, — но с
 * точки зрения конвейера делают одно и то же, поэтому и код у них общий.
 *
 * Общая черта: ни одна не даёт таймкодов по словам. Дальше по конвейеру слова
 * нужно разложить по говорящим, поэтому времена расставляем сами.
 */
interface SherpaSpec {
  id: string
  name: string
  dir: string
  /** Потоковая модель декодирует по мере поступления звука. */
  streaming: boolean
  /** Один файл (CTC) или три (transducer). */
  files: { model: string } | { encoder: string; decoder: string; joiner: string }
  language: string
  /**
   * Длина куска в секундах.
   *
   * Подбирается замером: Parakeet на двухминутных кусках роняет процесс
   * нативным сбоем, GigaAM их держит. Слишком мелкие куски тоже плохи —
   * распознавание на стыках теряет слова.
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

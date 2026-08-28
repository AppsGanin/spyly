/**
 * Сведение каналов и понижение частоты до 16 кГц.
 *
 * Отдельным файлом, а не строкой в blob: политика безопасности приложения не
 * пускает blob-скрипты, и загруженный так обработчик молча не запускался —
 * запись получалась идеальной тишиной.
 *
 * Частоту приводим здесь, а не в главном процессе: через границу процессов
 * тогда идёт вчетверо меньше данных.
 */
const TARGET_RATE = 16000

class Downsampler extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / TARGET_RATE
    this.buffer = []
    this.position = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    // Каналы складываем, а не берём первый: в стереодорожке голос может
    // оказаться только в одном канале, и половина разговора пропала бы.
    const frames = input[0].length
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let c = 0; c < input.length; c++) sum += input[c][i]
      this.buffer.push(sum / input.length)
    }

    const out = []
    while (this.position + this.ratio < this.buffer.length) {
      const at = Math.floor(this.position)
      const frac = this.position - at
      const a = this.buffer[at] ?? 0
      const b = this.buffer[at + 1] ?? a
      out.push(a + (b - a) * frac)
      this.position += this.ratio
    }

    // Съеденное отбрасываем, иначе буфер растёт до конца записи.
    const consumed = Math.floor(this.position)
    if (consumed > 0) {
      this.buffer = this.buffer.slice(consumed)
      this.position -= consumed
    }

    if (out.length > 0) this.port.postMessage(new Float32Array(out))
    return true
  }
}

registerProcessor('downsampler', Downsampler)

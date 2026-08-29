/**
 * Mixing the channels down and lowering the rate to 16 kHz.
 *
 * A file of its own rather than a string in a blob: the application's security
 * policy allows no blob scripts, and a worklet loaded that way silently failed
 * to start, so the recording came out as perfect silence.
 *
 * The rate is converted here rather than in the main process: a quarter as much
 * data then crosses the process boundary.
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

    // The channels are summed rather than taking the first: in a stereo track
    // the voice may sit in one channel only, and half the conversation would be lost.
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

    // What has been consumed is dropped, or the buffer grows until the end of the recording.
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

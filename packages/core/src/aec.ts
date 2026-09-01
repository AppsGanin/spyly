/**
 * Taking the speakers back out of the microphone.
 *
 * Without headphones the microphone hears the other side through the speakers,
 * and the recording holds both voices on one track. The system can remove this
 * itself, but only when the microphone and the speakers are one device; with an
 * external microphone, or a monitor playing the sound, the node does not start
 * at all and the echo is recorded in full.
 *
 * We are in a better position than any microphone-only noise remover: what went
 * to the speakers is written down separately and exactly. So the echo is not
 * guessed at — it is measured against the signal that caused it, band by band,
 * and subtracted.
 *
 * What is done here is a suppressor rather than a canceller: the gain of every
 * band is lowered by as much as the speakers explain of it. A canceller works
 * on the waveform and needs the delay to the sample; a suppressor works on
 * loudness and forgives the tens of milliseconds that the path through the air,
 * the sound card and the resampling add up to. For the purpose — so that
 * recognition does not write the other side down twice — that is enough, and it
 * cannot leave a metallic tail on speech the way an ill-converged canceller does.
 */

/** Both tracks are written at this rate; the frame sizes below assume it. */
const FRAME = 512

/**
 * A quarter of a frame, not a half.
 *
 * The window is applied twice, on the way in and on the way out, and the square
 * of a Hann window adds up to a constant only at this step. At a half it swings
 * between 0.5 and 1 across every frame: speech came out a quarter quieter and
 * with a wobble in it that was not there before.
 */
const HOP = FRAME / 4

/**
 * How much of the estimated echo is taken out.
 *
 * Above one on purpose: the estimate is always a little short — the path adds
 * reverberation that no single coefficient describes — and what is left of the
 * other side is more harmful than a slightly over-trimmed own voice.
 */
const OVERSUBTRACT = 1.4

/**
 * The quietest a band may become.
 *
 * Not zero: silence in a band that was loud a moment ago is heard as a metallic
 * warble, and recognition stumbles on it worse than on the echo itself.
 */
const GAIN_FLOOR = 0.08

/** How quickly the estimate of the path from speakers to microphone follows changes. */
const ADAPT = 0.05

/** Hann window: the frames are added back together, and the edges must not click. */
function hann(size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  return w
}

/**
 * The Fourier transform, in place, on a power-of-two length.
 *
 * Written out here rather than taken from a package: it is forty lines, and a
 * dependency in the core is paid for on every platform we build for.
 */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!
        const ai = im[i + k]!
        const br = re[i + k + len / 2]!
        const bi = im[i + k + len / 2]!
        const tr = br * cr - bi * ci
        const ti = br * ci + bi * cr
        re[i + k] = ar + tr
        im[i + k] = ai + ti
        re[i + k + len / 2] = ar - tr
        im[i + k + len / 2] = ai - ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/** The inverse, through the conjugate: one transform serves both directions. */
function ifft(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < im.length; i++) im[i] = -im[i]!
  fft(re, im)
  const n = re.length
  for (let i = 0; i < n; i++) {
    re[i] = re[i]! / n
    im[i] = -im[i]! / n
  }
}

/**
 * Remove from the microphone what the speakers were playing.
 *
 * `shiftSec` is how much later the microphone holds the same sound: the tracks
 * do not start together and the path through the air takes its time. It is
 * measured elsewhere, by the outlines of the two recordings, and is expected to
 * be near zero on a well-behaved recording. It may be given as a function of
 * time: on older recordings, made before the tracks were kept in step, the
 * shift grows over the hour, and one number for the whole file cleans the
 * beginning or the end but not both.
 *
 * The microphone track is returned as a new array; the original is not touched.
 * Speech of your own passes through: the speakers explain nothing of it, so
 * nothing is taken away.
 */
export function removeSpeakers(
  mic: Float32Array,
  system: Float32Array,
  sampleRate: number,
  shiftSec: number | ((atSec: number) => number) = 0
): Float32Array {
  const window = hann(FRAME)
  const out = new Float32Array(mic.length)
  // What the squares of the windows add up to at each sample. In the middle it
  // is a constant, and dividing by that constant would do — but at the very
  // beginning and end fewer windows overlap, and there the same constant left
  // the first and last tens of milliseconds quieter than they were recorded.
  const weight = new Float32Array(mic.length)
  const bins = FRAME / 2 + 1

  // How much of each band the speakers put into the microphone. One number per
  // band, followed slowly: the room does not change during a conversation.
  const path = new Float32Array(bins)

  const micRe = new Float32Array(FRAME)
  const micIm = new Float32Array(FRAME)
  const sysRe = new Float32Array(FRAME)
  const sysIm = new Float32Array(FRAME)

  // The shift may change over the recording, so it is asked for frame by frame.
  const shiftAt = typeof shiftSec === 'number' ? () => shiftSec : shiftSec

  for (let at = 0; at + FRAME <= mic.length; at += HOP) {
    const shift = Math.round(shiftAt(at / sampleRate) * sampleRate)
    for (let i = 0; i < FRAME; i++) {
      micRe[i] = mic[at + i]! * window[i]!
      micIm[i] = 0
      // The same moment on the system track, allowing for the shift between them.
      const j = at + i - shift
      sysRe[i] = j >= 0 && j < system.length ? system[j]! * window[i]! : 0
      sysIm[i] = 0
    }
    fft(micRe, micIm)
    fft(sysRe, sysIm)

    for (let k = 0; k < bins; k++) {
      const micMag = Math.hypot(micRe[k]!, micIm[k]!)
      const sysMag = Math.hypot(sysRe[k]!, sysIm[k]!)

      // The path is learnt only where the speakers were actually sounding, and
      // only where they are the louder of the two: while a person speaks over
      // them the microphone says nothing about the room, and learning from it
      // would teach the filter to subtract that person's own voice.
      if (sysMag > 1e-4 && micMag < sysMag) {
        path[k] = (1 - ADAPT) * path[k]! + ADAPT * (micMag / sysMag)
      }

      const echo = path[k]! * sysMag * OVERSUBTRACT
      const gain = micMag > 0 ? Math.max(GAIN_FLOOR, (micMag - echo) / micMag) : 1
      micRe[k] = micRe[k]! * gain
      micIm[k] = micIm[k]! * gain
      // The upper half of the spectrum mirrors the lower one, and must stay a mirror.
      if (k > 0 && k < FRAME / 2) {
        micRe[FRAME - k] = micRe[FRAME - k]! * gain
        micIm[FRAME - k] = micIm[FRAME - k]! * gain
      }
    }

    ifft(micRe, micIm)
    for (let i = 0; i < FRAME; i++) {
      out[at + i] = out[at + i]! + micRe[i]! * window[i]!
      weight[at + i] = weight[at + i]! + window[i]! * window[i]!
    }
  }

  for (let i = 0; i < out.length; i++) {
    // Where no window reached at all — the last samples, shorter than one frame
    // — the recording is kept as it was. Cleaning it is not possible, and
    // silence in its place would be a worse answer than the echo.
    out[i] = weight[i]! > 1e-6 ? out[i]! / weight[i]! : mic[i]!
  }
  return out
}

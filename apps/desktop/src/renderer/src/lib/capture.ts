import { t } from '@spyly/core'
/**
 * Audio capture through Chromium, for Windows and Linux.
 *
 * On macOS this path does not work: `getDisplayMedia({ audio: 'loopback' })`
 * hands back an already ended track there. On Windows (WASAPI loopback) and
 * Linux (PipeWire through the portal) it is the normal path, and no native
 * code is needed.
 *
 * The audio arrives at the sound card's rate (44.1 or 48 kHz) and in stereo,
 * while recognition needs mono at 16 kHz: it is converted right here, so that a
 * quarter as much data crosses the process boundary.
 */
/** A chunk of about 64 ms: more often means needless process hops, less often a noticeable delay. */
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
  // The file sits next to index.html: the application's security policy allows
  // neither blob nor data scripts, and a worklet that quietly failed to start
  // gives a perfectly empty recording, the worst kind of breakage.
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
  // Without being connected to the output the worklet is not called at all in
  // some versions of Chromium; the volume is muted so the audio does not reach
  // the speakers.
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
 * Starting the capture. Returns what actually opened.
 *
 * One track failing does not cancel the other: recording at least your own
 * voice beats recording nothing.
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
      // We have no use for the picture, so it is switched off at once, otherwise
      // Chromium goes on encoding frames and heating the processor for the whole recording.
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

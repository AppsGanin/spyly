import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { t, VoiceProfile, averageEmbedding } from '@spyly/core'
import { NativeCapture, SAMPLE_RATE } from '../audio/native.js'
import { WavWriter } from '../audio/wav.js'
import { embedSpeaker, readWave } from '../providers/diarization/sherpa.js'
import { readMeeting } from './meetings.js'
import { audioFile, ensureDir, speakersFile, storageRoot } from './paths.js'

/**
 * The voice registry.
 *
 * This is biometrics, so the file stays local, goes to no cloud provider, and
 * can be deleted in full from settings.
 */

async function readAll(): Promise<VoiceProfile[]> {
  const file = speakersFile()
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown[]
    return raw.map((r) => VoiceProfile.safeParse(r)).flatMap((p) => (p.success ? [p.data] : []))
  } catch {
    return []
  }
}

async function writeAll(profiles: VoiceProfile[]): Promise<void> {
  await ensureDir(storageRoot())
  await writeFile(speakersFile(), JSON.stringify(profiles, null, 2), 'utf8')
}

/**
 * Bring the old default name into line with the current one.
 *
 * Your own voice used to be saved under the name "Me", and that name was put
 * against the participant in the transcript, while the player and the filter
 * call the same speech "You". Only this default is changed: a name chosen by a
 * person stays as it is, and it can be renamed back in settings.
 */
async function renameLegacyOwnVoice(profiles: VoiceProfile[]): Promise<VoiceProfile[]> {
  const stale = profiles.filter((p) => p.isMe && p.name === 'Я')
  if (stale.length === 0) return profiles
  const renamed = profiles.map((p) => (p.isMe && p.name === 'Я' ? { ...p, name: t('Вы') } : p))
  await writeAll(renamed)
  return renamed
}

export async function listVoices(): Promise<VoiceProfile[]> {
  return renameLegacyOwnVoice(await readAll())
}

export async function deleteVoice(id: string): Promise<void> {
  await writeAll((await readAll()).filter((p) => p.id !== id))
}

export async function upsertVoice(
  name: string,
  embedding: number[],
  opts: { isMe?: boolean } = {}
): Promise<VoiceProfile> {
  const profiles = await readAll()
  const now = new Date().toISOString()
  const existing = profiles.find((p) => p.name.toLowerCase() === name.trim().toLowerCase())

  if (existing) {
    // Averaged with the old print: the more confirmations, the steadier the profile.
    const merged = averageEmbedding([existing.embedding, embedding])
    const next: VoiceProfile = {
      ...existing,
      embedding: merged.length ? merged : existing.embedding,
      samples: existing.samples + 1,
      updatedAt: now,
      isMe: opts.isMe ?? existing.isMe
    }
    await writeAll(profiles.map((p) => (p.id === existing.id ? next : p)))
    return next
  }

  const created: VoiceProfile = {
    id: `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim(),
    isMe: opts.isMe ?? false,
    embedding,
    createdAt: now,
    updatedAt: now,
    samples: 1
  }
  await writeAll([...profiles, created])
  return created
}

/** Remember a meeting speaker's voice under the name that was entered. */
export async function rememberSpeaker(meetingId: string, speakerId: string, name: string): Promise<VoiceProfile | null> {
  if (!name.trim()) return null
  const meeting = await readMeeting(meetingId)
  const speaker = meeting?.speakers.find((s) => s.id === speakerId)
  if (!meeting || !speaker) return null

  const wav = audioFile(meetingId, speaker.track)
  if (!existsSync(wav)) return null

  // This speaker's segments are rebuilt from the finished utterances: there is no
  // point storing the diarization result separately, it follows entirely from the transcript.
  const turns = meeting.utterances
    .filter((u) => u.speakerId === speakerId)
    .map((u) => ({ start: u.start, end: u.end, cluster: speaker.cluster }))
  if (turns.length === 0) return null

  const wave = await readWave(wav)
  const embedding = embedSpeaker(wave.samples, wave.sampleRate, turns, speaker.cluster)
  if (!embedding) return null
  return upsertVoice(name, embedding, { isMe: speaker.isMe })
}

// ── recording a voice profile during onboarding ─────────────────────────────

interface Enrollment {
  capture: NativeCapture
  writer: WavWriter
  file: string
}

let enrollment: Enrollment | null = null

export async function startEnrollment(): Promise<void> {
  await stopEnrollment()
  const file = path.join(os.tmpdir(), `spyly-enroll-${Date.now()}.wav`)
  const writer = new WavWriter({ path: file, sampleRate: SAMPLE_RATE, channels: 1 })
  await writer.open()
  const capture = new NativeCapture({ source: 'mic' })
  capture.on('samples', (chunk: Float32Array) => writer.writeFloat32(chunk))
  capture.start()
  enrollment = { capture, writer, file }
}

async function stopEnrollment(): Promise<string | null> {
  const current = enrollment
  if (!current) return null
  enrollment = null
  current.capture.stop()
  await new Promise((r) => setTimeout(r, 200))
  await current.writer.close()
  return current.file
}

/** Finish recording a profile and save the print under the user's name. */
export async function finishEnrollment(name: string): Promise<VoiceProfile | null> {
  const file = await stopEnrollment()
  if (!file || !existsSync(file)) return null
  try {
    const wave = await readWave(file)
    const seconds = wave.samples.length / wave.sampleRate
    if (seconds < 3) return null
    const embedding = embedSpeaker(
      wave.samples,
      wave.sampleRate,
      [{ start: 0, end: seconds, cluster: 0 }],
      0,
      30
    )
    if (!embedding) return null
    return await upsertVoice(name || t('Вы'), embedding, { isMe: true })
  } finally {
    await rm(file, { force: true })
  }
}

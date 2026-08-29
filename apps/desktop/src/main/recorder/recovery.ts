import { existsSync, statSync } from 'node:fs'
import { t, MeetingMeta } from '@spyly/core'
import { repairWav } from '../audio/wav.js'
import { findBrokenMeetings, findOrphanedRecordings, listMeetings, writeMeta } from '../store/meetings.js'
import { audioFile, meetingDir } from '../store/paths.js'

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const WAV_HEADER = 44

/**
 * Repair recordings left behind by a crash.
 *
 * The WAV header is updated as the recording goes, but the last seconds may
 * still not make it into the length, so it is recomputed from the actual file
 * size and the "recording" status is cleared, or the meeting would hang in the
 * list as active forever.
 */
export async function recoverOrphanedRecordings(): Promise<MeetingMeta[]> {
  // First the descriptions lost to a damaged meta.json are restored: otherwise
  // such recordings would not even reach the list of orphans.
  await rebuildBrokenMeetings()

  // Processing interrupted by the application closing hangs forever otherwise:
  // the stage stays "running", a spinner turns, and there is nobody to continue it.
  await unstickProcessing()

  const orphans = await findOrphanedRecordings()
  const recovered: MeetingMeta[] = []

  for (const meta of orphans) {
    let durationSec = 0
    for (const track of ['mic', 'system'] as const) {
      const file = audioFile(meta.id, track)
      if (!existsSync(file)) continue
      await repairWav(file)
      const bytes = Math.max(0, statSync(file).size - WAV_HEADER)
      durationSec = Math.max(durationSec, bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE))
    }

    const next: MeetingMeta = {
      ...meta,
      durationSec,
      endedAt: meta.endedAt ?? new Date().toISOString(),
      stages: { ...meta.stages, recording: durationSec > 0 ? 'done' : 'failed' },
      errors: durationSec > 0
        ? meta.errors
        : { ...meta.errors, recording: t('запись прервалась и не содержит звука') }
    }
    await writeMeta(next)
    recovered.push(next)
  }

  return recovered
}

/**
 * Rebuild a recording's description when meta.json is damaged.
 *
 * The folder name holds the date and the title, which is enough to bring the
 * recording back into the list. The transcript is left alone: if it is intact
 * it will be picked up by itself, and if not, processing can be run again.
 */
async function rebuildBrokenMeetings(): Promise<void> {
  for (const id of await findBrokenMeetings()) {
    let durationSec = 0
    for (const track of ['mic', 'system'] as const) {
      const file = audioFile(id, track)
      if (!existsSync(file)) continue
      await repairWav(file)
      const bytes = Math.max(0, statSync(file).size - WAV_HEADER)
      durationSec = Math.max(durationSec, bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE))
    }

    // `2026-08-27--billing-call--a1b2` gives the date and the title.
    const parts = id.split('--')
    const date = parts[0] ?? ''
    const slug = (parts[1] ?? '').replace(/-/g, ' ').trim()
    const startedAt = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(`${date}T12:00:00`).toISOString()
      : new Date(statSync(meetingDir(id)).birthtime).toISOString()

    await writeMeta(
      MeetingMeta.parse({
        id,
        title: slug ? slug[0]!.toUpperCase() + slug.slice(1) : t('Восстановленная запись'),
        startedAt,
        endedAt: new Date().toISOString(),
        durationSec,
        sources: {
          mic: existsSync(audioFile(id, 'mic')),
          system: existsSync(audioFile(id, 'system'))
        },
        stages: { recording: durationSec > 0 ? 'done' : 'failed' },
        errors: { recording: t('описание записи было повреждено и восстановлено по файлам') }
      })
    )
  }
}

/**
 * Clear processing stages that are stuck.
 *
 * The application may have been closed or killed in the middle of
 * transcription. Nothing terrible has happened, the audio is there, but the
 * stage stayed "running": a spinner turns in the list and there is nobody to
 * carry the work on. We mark it interrupted and explain what to do; the
 * "Process again" button is already on the recording page.
 */
async function unstickProcessing(): Promise<void> {
  const stages = ['transcribing', 'diarizing', 'identifying', 'summarizing'] as const

  for (const meta of await listMeetings()) {
    const stuck = stages.filter((stage) => meta.stages[stage] === 'running')
    if (stuck.length === 0) continue

    await writeMeta({
      ...meta,
      stages: { ...meta.stages, ...Object.fromEntries(stuck.map((stage) => [stage, 'failed'])) },
      errors: {
        ...meta.errors,
        ...Object.fromEntries(
          stuck.map((stage) => [stage, t('обработка прервалась — запустите её заново')])
        )
      }
    })
  }
}

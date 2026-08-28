import { existsSync, statSync } from 'node:fs'
import { t, MeetingMeta } from '@spyly/core'
import { repairWav } from '../audio/wav.js'
import { findBrokenMeetings, findOrphanedRecordings, listMeetings, writeMeta } from '../store/meetings.js'
import { audioFile, meetingDir } from '../store/paths.js'

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const WAV_HEADER = 44

/**
 * Починить записи, оставшиеся после падения приложения.
 *
 * Заголовок WAV обновляется по ходу записи, но последние секунды всё равно
 * могут не попасть в длину, поэтому пересчитываем её по фактическому размеру
 * файла и снимаем статус «идёт запись», иначе встреча навсегда зависнет
 * в списке как активная.
 */
export async function recoverOrphanedRecordings(): Promise<MeetingMeta[]> {
  // Сперва восстанавливаем описания, потерянные из-за битого meta.json:
  // иначе такие записи не попадут даже в список осиротевших.
  await rebuildBrokenMeetings()

  // Обработка, прерванная закрытием приложения, иначе висит вечно: этап
  // остаётся «идёт», крутится кружок, и продолжить его некому.
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
 * Собрать описание записи заново, когда meta.json испорчен.
 *
 * Имя папки хранит дату и название — этого хватает, чтобы вернуть запись в
 * список. Расшифровку не трогаем: если она цела, она подхватится сама, а если
 * нет — обработку можно запустить заново.
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

    // `2026-08-27--sozvon-po-billingu--a1b2` → дата и название.
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
 * Снять зависшие этапы обработки.
 *
 * Приложение могли закрыть или снять посреди расшифровки. Ничего страшного не
 * произошло — звук на месте, — но этап так и остался «идёт»: в списке крутится
 * кружок, а продолжить работу некому. Помечаем прерванным и объясняем, что
 * делать: кнопка «Повторить обработку» уже есть на странице записи.
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

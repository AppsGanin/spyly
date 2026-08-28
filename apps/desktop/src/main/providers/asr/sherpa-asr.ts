import { t } from '@spyly/core'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AsrResult, AsrSegment, Word } from '@spyly/core'
import { isDownloaded, modelsDir } from '../../pipeline/models.js'
import { SPECS, SHERPA_MODEL_IDS, type SherpaSpec } from './sherpa-specs.js'
import type { AsrJob, AsrReply } from './sherpa-worker.js'
import type { AsrProvider, TranscribeOptions } from '../types.js'

export { SHERPA_MODEL_IDS }

function fileIn(spec: SherpaSpec, name: string): string {
  return path.join(modelsDir(), spec.dir, name)
}

/** Час записи считается минутами; ждём с запасом, но не бесконечно. */
const WORKER_TIMEOUT_MS = 40 * 60_000

/**
 * Расшифровать файл в отдельном процессе.
 *
 * Ход работы приходит сообщениями, поэтому полоска прогресса остаётся живой,
 * а отмена — это просто снятие процесса.
 */
async function transcribeInWorker(
  job: AsrJob,
  options: TranscribeOptions
): Promise<Word[]> {
  const { utilityProcess, app } = await import('electron')
  const entry = path.join(app.getAppPath(), 'out', 'main', 'sherpa-worker.js')
  if (!existsSync(entry)) throw new Error(t('не найден {entry}', { entry: entry }))

  return new Promise<Word[]>((resolve, reject) => {
    const child = utilityProcess.fork(entry, [], { stdio: 'inherit' })
    let done = false
    const finish = (run: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      child.kill()
      run()
    }
    const abort = (): void => finish(() => resolve([]))
    const timer = setTimeout(
      () => finish(() => reject(new Error(t('расшифровка не уложилась во время')))),
      WORKER_TIMEOUT_MS
    )
    options.signal?.addEventListener('abort', abort, { once: true })

    child.on('message', (reply: AsrReply) => {
      if (reply.type === 'progress') options.onProgress?.(reply.value)
      else if (reply.type === 'done') finish(() => resolve(reply.words))
      else finish(() => reject(new Error(reply.message)))
    })
    child.on('exit', (code) => finish(() => reject(new Error(t('процесс завершился с кодом {code}', { code: code })))))
    child.postMessage(job)
  })
}

/** Провайдер для одной модели: снаружи все они выглядят одинаково. */
function sherpaProvider(spec: SherpaSpec): AsrProvider {
  return {
    id: spec.id,
    name: spec.name,
    local: true,
    capabilities: { streaming: false, diarization: false, wordTimestamps: false },

    async ready() {
      if (!isDownloaded(spec.id)) return { ready: false, hint: t('модель не скачана') }
      const first = 'model' in spec.files ? spec.files.model : spec.files.encoder
      if (!existsSync(fileIn(spec, first))) return { ready: false, hint: t('файлы модели не найдены') }
      return { ready: true }
    },

    async transcribe(wavPath, track, options: TranscribeOptions): Promise<AsrResult> {
      if (!existsSync(wavPath)) throw new Error(t('нет файла записи: {wavPath}', { wavPath: wavPath }))

      const words = await transcribeInWorker(
        { specId: spec.id, wavPath, modelsDir: modelsDir() },
        options
      )
      if (words.length === 0) return { track, language: spec.language, segments: [] }

      const segments: AsrSegment[] = [
        {
          text: words.map((w) => w.text).join(' '),
          start: words[0]!.start,
          end: words[words.length - 1]!.end,
          words
        }
      ]
      return { track, language: spec.language, segments }
    }
  }
}

export const SHERPA_ASR_PROVIDERS: AsrProvider[] = SPECS.map(sherpaProvider)

/** Провайдер по идентификатору модели; null — модель не отсюда. */
export function sherpaProviderFor(modelId: string): AsrProvider | null {
  const index = SPECS.findIndex((s) => s.id === modelId)
  return index === -1 ? null : SHERPA_ASR_PROVIDERS[index]!
}

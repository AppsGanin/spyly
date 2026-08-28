import { t } from '@spyly/core'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { AsrResult, AsrSegment, Word } from '@spyly/core'
import { splitOnSilence } from '../../audio/wav.js'
import { isDownloaded, modelPath } from '../../pipeline/models.js'
import { loadSettings } from '../../store/settings.js'
import type { AsrProvider, TranscribeOptions } from '../types.js'

function binaryPath(): string {
  const name = 'whisper-cli'
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'bin', name)]
    : [
        path.join(process.cwd(), 'native', 'whisper', 'build', 'bin', name),
        path.join(app.getAppPath(), '..', '..', 'native', 'whisper', 'build', 'bin', name)
      ]
  return candidates.find(existsSync) ?? candidates[0]!
}

/** Формат `-oj -ojf`: сегменты с токенами, у каждого свои таймкоды. */
interface WhisperJson {
  transcription?: {
    timestamps?: { from: string; to: string }
    offsets?: { from: number; to: number }
    text?: string
    tokens?: { text: string; offsets?: { from: number; to: number }; p?: number }[]
  }[]
}

/** Служебные токены Whisper вида `[_BEG_]`, `<|ru|>` в текст попадать не должны. */
function isSpecialToken(text: string): boolean {
  return /^\s*(\[_[A-Z]+_\]|<\|.*?\|>)\s*$/.test(text)
}

/**
 * Разбор вывода whisper.cpp, запущенного с `-ml 1 -sow`.
 *
 * В этом режиме единицей сегмента является слово, поэтому словами становятся
 * именно сегменты. Токены внутри — это подслова («об», «суд», «им»), склеивать
 * расшифровку из них нельзя: текст развалится на куски. Они годятся только на
 * то, чтобы усреднить уверенность модели по слову.
 */
function wordsOf(raw: WhisperJson): Word[] {
  const words: Word[] = []

  for (const item of raw.transcription ?? []) {
    const text = (item.text ?? '').trim()
    if (!text || isSpecialToken(text)) continue

    const start = (item.offsets?.from ?? 0) / 1000
    const end = Math.max(start, (item.offsets?.to ?? 0) / 1000)

    const probs = (item.tokens ?? [])
      .filter((t) => !isSpecialToken(t.text) && typeof t.p === 'number')
      .map((t) => t.p!)
    const confidence = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : undefined

    words.push({ text, start, end, confidence })
  }

  return words
}

/** Слова → результат распознавания. */
function assemble(words: Word[], track: 'mic' | 'system', language: string): AsrResult {
  if (words.length === 0) return { track, language, segments: [] }

  // Дальше по конвейеру слова всё равно перегруппируются по говорящим,
  // поэтому дробить их здесь на предложения бессмысленно.
  const segments: AsrSegment[] = [
    {
      text: words.map((w) => w.text).join(' '),
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      words
    }
  ]
  return { track, language, segments }
}

export const whisperCppProvider: AsrProvider = {
  id: 'whisper-cpp',
  name: t('Whisper (локально)'),
  local: true,
  capabilities: { streaming: true, diarization: false, wordTimestamps: true },

  async ready() {
    if (!existsSync(binaryPath())) {
      return { ready: false, hint: t('не найден движок whisper.cpp') }
    }
    const settings = await loadSettings()
    setPreferredModel(settings.asrModel)
    if (!isDownloaded(preferredModel())) {
      return { ready: false, hint: t('модель не скачана') }
    }
    return { ready: true }
  },

  async transcribe(wavPath, track, options: TranscribeOptions): Promise<AsrResult> {
    setPreferredModel((await loadSettings()).asrModel)
    const modelId = preferredModel()
    const model = modelPath(modelId)
    if (!model || !existsSync(model)) throw new Error(t('модель Whisper не скачана'))
    if (!existsSync(wavPath)) throw new Error(t('нет файла записи: {wavPath}', { wavPath: wavPath }))

    const prompt = await buildVocabularyPrompt()

    // На «определять автоматически» whisper выбирает язык один раз, по первым
    // тридцати секундам, и дальше держится за него — фраза по-английски
    // посреди русского разговора приедет транслитерацией. Поэтому режем запись
    // по тишине и определяем язык на каждом куске отдельно.
    if (options.language === 'auto') {
      const parts = await splitOnSilence(wavPath)
      if (parts.length > 1) {
        const words: Word[] = []
        const languages: string[] = []
        try {
          for (const [index, part] of parts.entries()) {
            if (options.signal?.aborted) break
            const result = await runWhisper(model, part.path, 'auto', prompt, {
              ...options,
              onProgress: (value) => options.onProgress?.((index + value) / parts.length)
            })
            for (const word of result.words) {
              words.push({ ...word, start: word.start + part.offsetSec, end: word.end + part.offsetSec })
            }
            if (result.language) languages.push(result.language)
          }
        } finally {
          await Promise.all(parts.map((part) => rm(part.path, { force: true })))
        }
        return assemble(words, track, mostCommon(languages) ?? 'auto')
      }
    }

    const single = await runWhisper(model, wavPath, options.language, prompt, options)
    return assemble(single.words, track, single.language || options.language)
  }
}

/**
 * Один прогон whisper.cpp по файлу.
 *
 * Возвращает и распознанный язык: при `auto` он нужен вызывающему, чтобы
 * понять, на чём в итоге говорили.
 */
async function runWhisper(
  model: string,
  wavPath: string,
  language: string,
  prompt: string,
  options: Pick<TranscribeOptions, 'signal' | 'onProgress'>
): Promise<{ words: Word[]; language: string }> {
  const outPrefix = path.join(os.tmpdir(), `spyly-${path.basename(wavPath, '.wav')}-${Date.now()}`)
  const args = [
    '-m', model,
    '-f', wavPath,
    '-l', language,
    '-oj', '-ojf',
    '-of', outPrefix,
    '-pp',
    // Пословное деление: без него таймкоды приходят на 5–30-секундные куски,
    // и диаризация не сможет разложить их по говорящим.
    '-ml', '1',
    '-sow',
    '-t', String(Math.max(2, Math.min(8, os.cpus().length - 2))),
    // Не тащим текст предыдущего окна в следующее: именно на этом Whisper
    // сваливается в повтор и выдаёт одну фразу двадцать раз подряд там, где
    // человек её не говорил.
    '-mc', '0',
    // Порог энтропии: при вырождении декодирование повторяется с другой
    // температурой вместо того, чтобы залипнуть.
    '-et', '2.8',
    // Подсказка со словами, которых модель иначе не знает: имена коллег,
    // названия проектов, жаргон. Без carry-initial-prompt она действует
    // только на первые тридцать секунд, а разговор идёт час.
    ...(prompt ? ['--prompt', prompt, '--carry-initial-prompt'] : [])
  ]

  let detected = ''
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    options.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })

    const watch = (text: string) => {
      const progress = /progress\s*=\s*(\d+)%/i.exec(text)
      if (progress?.[1]) options.onProgress?.(Number(progress[1]) / 100)
      const language = /auto-detected language:\s*([a-z]{2,3})/i.exec(text)
      if (language?.[1]) detected = language[1].toLowerCase()
    }

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      watch(text)
    })
    child.stdout.on('data', (chunk: Buffer) => watch(chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`whisper завершился с кодом ${code}: ${stderr.slice(-400)}`))
    })
  })

  const jsonPath = `${outPrefix}.json`
  try {
    const raw = JSON.parse(await readFile(jsonPath, 'utf8')) as WhisperJson
    return { words: wordsOf(raw), language: detected }
  } finally {
    await rm(jsonPath, { force: true })
  }
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: string | null = null
  let top = 0
  for (const [value, count] of counts) {
    if (count > top) {
      best = value
      top = count
    }
  }
  return best
}

/** Порядок «по умолчанию»: крупнее — точнее, поэтому сверху самая крупная. */
const WHISPER_MODELS = ['whisper-large-v3', 'whisper-large-v3-turbo', 'whisper-medium', 'whisper-small']

let chosenModel = ''

/** Явный выбор пользователя из настроек; пусто — решаем сами. */
export function setPreferredModel(id: string): void {
  chosenModel = id
}

export function preferredModel(): string {
  if (chosenModel && isDownloaded(chosenModel)) return chosenModel
  for (const id of WHISPER_MODELS) {
    if (isDownloaded(id)) return id
  }
  return 'whisper-large-v3-turbo'
}

/**
 * Подсказка распознаванию: имена и термины.
 *
 * Whisper не знает, что «биллинг» — это биллинг, а не «Беллинге», пока не
 * увидит слово в контексте. Имена запомненных участников подставляются сами:
 * их пользователь уже ввёл, повторять незачем.
 */
async function buildVocabularyPrompt(): Promise<string> {
  const settings = await loadSettings()
  const terms = new Set(settings.vocabulary.map((t) => t.trim()).filter(Boolean))

  try {
    const { listVoices } = await import('../../store/voices.js')
    for (const voice of await listVoices()) {
      if (voice.name.trim()) terms.add(voice.name.trim())
    }
  } catch {
    // Реестр голосов недоступен — обойдёмся одним словарём.
  }

  if (terms.size === 0) return ''
  // Модель ждёт связный текст, а не список: так подсказка работает лучше.
  return `В разговоре встречаются: ${[...terms].join(', ')}.`
}

export { buildVocabularyPrompt }

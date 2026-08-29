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

/** The `-oj -ojf` format: segments with tokens, each with its own timestamps. */
interface WhisperJson {
  transcription?: {
    timestamps?: { from: string; to: string }
    offsets?: { from: number; to: number }
    text?: string
    tokens?: { text: string; offsets?: { from: number; to: number }; p?: number }[]
  }[]
}

/** Whisper's own tokens such as `[_BEG_]` and `<|ru|>` must not end up in the text. */
function isSpecialToken(text: string): boolean {
  return /^\s*(\[_[A-Z]+_\]|<\|.*?\|>)\s*$/.test(text)
}

/**
 * Parsing the output of whisper.cpp run with `-ml 1 -sow`.
 *
 * In this mode the unit of a segment is a word, so the segments are what
 * become words. The tokens inside are sub-words ("ju", "dic", "ial"), and a
 * transcript cannot be glued together out of them: the text falls apart. They
 * are only good for averaging the model's confidence over a word.
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

/** Words to a recognition result. */
function assemble(words: Word[], track: 'mic' | 'system', language: string): AsrResult {
  if (words.length === 0) return { track, language, segments: [] }

  // Further down the pipeline the words get regrouped by speaker anyway, so
  // breaking them into sentences here is pointless.
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

    // On "detect automatically" whisper picks the language once, from the first
    // thirty seconds, and holds on to it after that: an English phrase in the
    // middle of a Russian conversation arrives transliterated. So we cut the
    // recording at the silences and detect the language on each piece separately.
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
 * One run of whisper.cpp over a file.
 *
 * It also returns the language it recognised: with `auto` the caller needs it
 * to know what was actually being spoken.
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
    // Word-level splitting: without it the timestamps come for 5 to 30 second
    // chunks, and diarization cannot lay them out by speaker.
    '-ml', '1',
    '-sow',
    '-t', String(Math.max(2, Math.min(8, os.cpus().length - 2))),
    // The text of the previous window is not carried into the next: this is exactly
    // where Whisper falls into repetition and emits one phrase twenty times in a
    // row where nobody said it.
    '-mc', '0',
    // The entropy threshold: on degeneration, decoding is retried at a different
    // temperature instead of getting stuck.
    '-et', '2.8',
    // A hint with words the model would otherwise not know: colleagues' names,
    // project names, jargon. Without carry-initial-prompt it only affects the
    // first thirty seconds, while a conversation runs for an hour.
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

/** The "default" order: larger is more accurate, so the largest is on top. */
const WHISPER_MODELS = ['whisper-large-v3', 'whisper-large-v3-turbo', 'whisper-medium', 'whisper-small']

let chosenModel = ''

/** An explicit choice by the user in settings; empty means we decide. */
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
 * A hint to recognition: names and terms.
 *
 * Whisper does not know that "billing" is billing rather than "Belling" until
 * it sees the word in context. The names of remembered participants are filled
 * in automatically: the user has already entered them, no reason to ask again.
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
    // The voice registry is unavailable, so the dictionary alone will have to do.
  }

  if (terms.size === 0) return ''
  // The model expects connected text rather than a list: the hint works better that way.
  return `В разговоре встречаются: ${[...terms].join(', ')}.`
}

export { buildVocabularyPrompt }

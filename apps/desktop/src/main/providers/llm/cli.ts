import { t } from '@spyly/core'
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { enrichedPath, findBinary } from '../../binaries.js'
import type { LlmMessage, LlmProvider } from '../types.js'

/**
 * Конспект через уже установленный кодинг-агент.
 *
 * У Anthropic и OpenAI нет публичного OAuth для сторонних приложений — только
 * ключи. Но если у пользователя стоит Claude Code или Codex, они уже
 * авторизованы его подпиской, и конспект можно собрать через них: ключ вводить
 * не нужно, отдельная оплата по токенам не появляется.
 */

interface CliSpec {
  id: string
  name: string
  binary: string
  /** Аргументы разового запроса. `out` — файл для ответа, если движок так умеет. */
  args: (prompt: string, out: string) => string[]
  /**
   * Читать ответ из файла, а не из stdout.
   *
   * Codex пишет в stdout ещё и служебное: заголовок сессии и счётчик токенов.
   * Вычищать это регулярками — верный источник будущих поломок.
   */
  readsFile?: boolean
  hint: string
}

const SPECS: CliSpec[] = [
  {
    id: 'claude-cli',
    name: 'Claude Code',
    binary: 'claude',
    args: (prompt) => ['-p', prompt],
    hint: t('установите Claude Code — тогда ключ не понадобится')
  },
  {
    id: 'codex-cli',
    name: 'Codex',
    binary: 'codex',
    // Конспект собирается вне проекта, поэтому проверку на git-репозиторий
    // нужно снять, а песочницу оставить на чтение: модель здесь ничего не
    // должна ни запускать, ни менять.
    args: (prompt, out) => [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-last-message',
      out,
      prompt
    ],
    readsFile: true,
    hint: t('установите Codex CLI — тогда ключ не понадобится')
  }
]

async function run(spec: CliSpec, binary: string, prompt: string, timeoutMs = 180_000): Promise<string> {
  // Codex — скрипт с `#!/usr/bin/env node`, и без node в PATH он падает, даже
  // когда сам файл найден. У приложения, запущенного из Dock, такого PATH нет.
  const PATH = await enrichedPath()
  const out = path.join(os.tmpdir(), `spyly-llm-${Date.now()}-${process.pid}.txt`)

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, spec.args(prompt, out), {
        // stdin закрыт: иначе Codex ждёт продолжения запроса оттуда.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Агент запускается вне проекта: конспект не должен цеплять чужие файлы
        // и правила из случайной рабочей папки.
        cwd: os.tmpdir(),
        env: { ...process.env, PATH, CI: '1' }
      })
      let output = ''
      let err = ''
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(output.trim())
        else {
          const detail = (err || output).trim().slice(-300)
          reject(new Error(`${path.basename(binary)} завершился с кодом ${code}: ${detail}`))
        }
      })
    })

    if (!spec.readsFile) return stdout
    const text = await readFile(out, 'utf8').catch(() => '')
    // Файла может не оказаться — тогда лучше отдать хоть что-то из stdout.
    return text.trim() || stdout
  } finally {
    if (spec.readsFile) await rm(out, { force: true })
  }
}

function cliProvider(spec: CliSpec): LlmProvider {
  return {
    id: spec.id,
    name: spec.name,
    local: false,
    async ready() {
      return (await findBinary(spec.binary)) ? { ready: true } : { ready: false, hint: spec.hint }
    },
    async complete(messages: LlmMessage[]) {
      const binary = await findBinary(spec.binary)
      if (!binary) throw new Error(`${spec.name}: не найден исполняемый файл ${spec.binary}`)
      const prompt = messages.map((m) => m.content).join('\n\n')
      return run(spec, binary, prompt)
    }
  }
}

export const CLI_LLM_PROVIDERS: LlmProvider[] = SPECS.map(cliProvider)

import { t } from '@spyly/core'
import { execFile, spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LlmModelChoices } from '../../../shared/ipc.js'
import { enrichedPath, findBinary } from '../../binaries.js'
import type { LlmMessage, LlmOptions, LlmProvider, LlmReply } from '../types.js'

/**
 * A summary through a coding agent that is already installed.
 *
 * Anthropic and OpenAI have no public OAuth for third-party applications, only
 * API keys. But if the user has Claude Code or Codex installed, those are
 * already authorised by their subscription and a summary can be made through
 * them: no key to enter, no separate per-token bill.
 */

interface CliSpec {
  id: string
  name: string
  binary: string
  /**
   * Arguments for a one-off request. `model` is empty when the agent's own
   * choice stands; `out` is the file for the answer, if the engine can do that.
   */
  args: (prompt: string, model: string, out: string) => string[]
  /**
   * Read the answer from a file rather than from stdout.
   *
   * Codex also writes housekeeping to stdout: the session header and a token
   * counter. Cleaning that out with regular expressions is a sure source of
   * future breakage.
   */
  readsFile?: boolean
  /** The answer and the model that gave it, out of what the agent printed. */
  reply?: (output: string) => LlmReply
  /** Why the agent failed, out of what it printed, when that says more than stderr. */
  failure?: (output: string) => string | null
  /** The model the agent uses when none is picked here, from its own settings. */
  ownModel: () => Promise<string | null>
  /** Models to pick from; null when they cannot be learned and a name is typed by hand. */
  models: (binary: string) => Promise<ModelOption[] | null>
  hint: string
}

/** A value from a JSON file, or null for a missing or damaged one. */
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

type ModelOption = { id: string; label: string }

interface ClaudeResult {
  result?: string
  is_error?: boolean
  modelUsage?: Record<string, { outputTokens?: number }>
}

function parseClaude(output: string): ClaudeResult | null {
  try {
    return JSON.parse(output) as ClaudeResult
  } catch {
    return null
  }
}

/**
 * Claude Code's answer in JSON rather than as bare text: only there does it say
 * which model answered. Beside the main one it may call a small one for its
 * own housekeeping, so the model is the one that wrote the most.
 */
export function claudeReply(output: string): LlmReply {
  const data = parseClaude(output)
  if (!data) return { text: output }
  if (data.is_error) throw new Error(data.result || t('Claude Code вернул ошибку'))
  const [model] = Object.entries(data.modelUsage ?? {})
    .sort(([, a], [, b]) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0))
    .map(([name]) => name)
  return { text: (data.result ?? '').trim(), model }
}

interface CodexCatalog {
  models?: { slug?: string; display_name?: string; visibility?: string; priority?: number }[]
}

/** The list is the same for the whole session, and asking Codex for it takes a second or so. */
let codexCatalog: ModelOption[] | null = null

/**
 * The models Codex offers, from `codex debug models`.
 *
 * Only those it shows in its own picker (`visibility: "list"`), in its own
 * order: the rest are its internal ones, such as the reviewer. The list comes
 * from the account, so it holds exactly what this subscription can use. Null
 * when an older or newer Codex has no such command or answers differently:
 * then the name is typed, as before.
 */
async function codexModels(binary: string): Promise<ModelOption[] | null> {
  if (codexCatalog) return codexCatalog
  const PATH = await enrichedPath()
  const output = await new Promise<string>((resolve) => {
    execFile(
      binary,
      ['debug', 'models'],
      { cwd: os.tmpdir(), env: { ...process.env, PATH }, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? '' : stdout)
    )
  })
  try {
    const catalog = JSON.parse(output) as CodexCatalog
    const options = (catalog.models ?? [])
      .filter((m) => m.slug && m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((m) => ({ id: m.slug!, label: m.display_name || m.slug! }))
    if (options.length === 0) return null
    codexCatalog = options
    return options
  } catch {
    return null
  }
}

/**
 * The model from `~/.codex/config.toml`.
 *
 * Only the top-level `model = "..."` line: a TOML parser for one line is too
 * much, and the same key inside a profile section is not the default.
 */
async function codexModel(): Promise<string | null> {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  const text = await readFile(path.join(home, 'config.toml'), 'utf8').catch(() => '')
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break
    const match = /^\s*model\s*=\s*["']([^"']+)["']/.exec(line)
    if (match) return match[1]!
  }
  return null
}

const SPECS: CliSpec[] = [
  {
    id: 'claude-cli',
    name: 'Claude Code',
    binary: 'claude',
    args: (prompt, model) => ['-p', prompt, '--output-format', 'json', ...(model ? ['--model', model] : [])],
    reply: claudeReply,
    failure: (output) => parseClaude(output)?.result ?? null,
    ownModel: async () => {
      const model = (await readJson(path.join(os.homedir(), '.claude', 'settings.json')))?.model
      return typeof model === 'string' && model ? model : null
    },
    // Aliases rather than full names: Claude Code moves them to the latest
    // version itself, and a name written here would go stale with the next release.
    models: async () => [
      { id: 'fable', label: 'Fable' },
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' }
    ],
    hint: t('установите Claude Code — тогда ключ не понадобится')
  },
  {
    id: 'codex-cli',
    name: 'Codex',
    binary: 'codex',
    // The summary is assembled outside a project, so the git repository check has
    // to come off while the sandbox stays read-only: the model here should neither
    // run nor change anything.
    args: (prompt, model, out) => [
      'exec',
      ...(model ? ['--model', model] : []),
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-last-message',
      out,
      prompt
    ],
    readsFile: true,
    ownModel: codexModel,
    models: codexModels,
    hint: t('установите Codex CLI — тогда ключ не понадобится')
  }
]

async function run(spec: CliSpec, binary: string, prompt: string, model: string, timeoutMs = 180_000): Promise<string> {
  // Codex is a script with `#!/usr/bin/env node`, and without node in PATH it
  // fails even when the file itself is found. An app started from the Dock has
  // no such PATH.
  const PATH = await enrichedPath()
  const out = path.join(os.tmpdir(), `spyly-llm-${Date.now()}-${process.pid}.txt`)

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, spec.args(prompt, model, out), {
        // stdin is closed: otherwise Codex waits for the rest of the request from there.
        stdio: ['ignore', 'pipe', 'pipe'],
        // The agent starts outside a project: a summary must not pick up other files
        // and rules from whatever working folder it happens to be in.
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
          const detail = (spec.failure?.(output) || err || output).trim().slice(-300)
          reject(new Error(t('{binary} завершился с кодом {code}: {detail}', { binary: path.basename(binary), code: String(code), detail })))
        }
      })
    })

    if (!spec.readsFile) return stdout
    const text = await readFile(out, 'utf8').catch(() => '')
    // The file may not be there, and then handing back at least something from stdout is better.
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
    async complete(messages: LlmMessage[], options: LlmOptions = {}) {
      const binary = await findBinary(spec.binary)
      if (!binary) throw new Error(t('{name}: не найден исполняемый файл {binary}', { name: spec.name, binary: spec.binary }))
      const prompt = messages.map((m) => m.content).join('\n\n')
      const model = options.model?.trim() ?? ''
      const output = await run(spec, binary, prompt, model)
      if (spec.reply) return spec.reply(output)
      // An agent that does not say which model answered: the one asked for, or
      // the one in its settings, is the best that can be recorded.
      return { text: output, model: model || (await spec.ownModel()) || undefined }
    },
    async modelChoices(): Promise<LlmModelChoices> {
      const binary = await findBinary(spec.binary)
      const [options, fallback] = await Promise.all([binary ? spec.models(binary) : null, spec.ownModel()])
      return { options, fallback }
    }
  }
}

export const CLI_LLM_PROVIDERS: LlmProvider[] = SPECS.map(cliProvider)

import { t } from '@spyly/core'
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { enrichedPath, findBinary } from '../../binaries.js'
import type { LlmMessage, LlmProvider } from '../types.js'

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
  /** Arguments for a one-off request. `out` is the file for the answer, if the engine can do that. */
  args: (prompt: string, out: string) => string[]
  /**
   * Read the answer from a file rather than from stdout.
   *
   * Codex also writes housekeeping to stdout: the session header and a token
   * counter. Cleaning that out with regular expressions is a sure source of
   * future breakage.
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
    // The summary is assembled outside a project, so the git repository check has
    // to come off while the sandbox stays read-only: the model here should neither
    // run nor change anything.
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
  // Codex is a script with `#!/usr/bin/env node`, and without node in PATH it
  // fails even when the file itself is found. An app started from the Dock has
  // no such PATH.
  const PATH = await enrichedPath()
  const out = path.join(os.tmpdir(), `spyly-llm-${Date.now()}-${process.pid}.txt`)

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, spec.args(prompt, out), {
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
          const detail = (err || output).trim().slice(-300)
          reject(new Error(`${path.basename(binary)} завершился с кодом ${code}: ${detail}`))
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
    async complete(messages: LlmMessage[]) {
      const binary = await findBinary(spec.binary)
      if (!binary) throw new Error(`${spec.name}: не найден исполняемый файл ${spec.binary}`)
      const prompt = messages.map((m) => m.content).join('\n\n')
      return run(spec, binary, prompt)
    }
  }
}

export const CLI_LLM_PROVIDERS: LlmProvider[] = SPECS.map(cliProvider)

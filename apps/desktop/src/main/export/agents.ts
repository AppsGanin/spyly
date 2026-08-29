import { t } from '@spyly/core'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { enrichedPath, findBinary } from '../binaries.js'

/**
 * The environment for running other people's commands.
 *
 * An app started from the Dock sees neither node nor homebrew, and `claude`
 * and `codex` are scripts that need node to start at all.
 */
async function childEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: await enrichedPath() }
}
import { promisify } from 'node:util'
import { app } from 'electron'
import { storageRoot } from '../store/paths.js'

const run = promisify(execFile)

/**
 * Connecting Spyly to agents in one click.
 *
 * This used to be commands to copy into a terminal, but someone who records
 * calls should not have to go digging through config files. Each agent keeps
 * its MCP settings its own way, so each gets its own path here.
 */

export type AgentId = 'claude-desktop' | 'claude-code' | 'codex'

export interface AgentStatus {
  id: AgentId
  name: string
  installed: boolean
  connected: boolean
  /** Why it cannot be connected, when it cannot. */
  hint?: string
}

export interface AgentActionResult {
  ok: boolean
  message: string
}

/**
 * A path to the server that survives an application update.
 *
 * Writing down the path of the copy we started from will not do: if the app
 * was run out of a build folder or straight off a disk image, the link goes
 * stale at the first update and the agent quietly stops seeing recordings. So
 * an installed copy in Applications is preferred.
 */
const INSTALLED_APP = '/Applications/Spyly.app'

function serverCommand(): { command: string; args: string[]; env: Record<string, string> } {
  if (app.isPackaged) {
    const installed = path.join(INSTALLED_APP, 'Contents', 'Resources', 'bin', 'spyly-mcp')
    const running = path.join(process.resourcesPath, 'bin', 'spyly-mcp')
    return {
      command: existsSync(installed) ? installed : running,
      args: [],
      env: { SPYLY_DIR: storageRoot() }
    }
  }
  return {
    command: process.execPath,
    args: [path.join(process.cwd(), 'packages', 'mcp-server', 'dist', 'index.js')],
    env: { SPYLY_DIR: storageRoot(), ELECTRON_RUN_AS_NODE: '1' }
  }
}

/** Whether the app is running from outside Applications, where a recorded path is short-lived. */
function runningFromTemporaryLocation(): boolean {
  if (!app.isPackaged) return false
  return !existsSync(path.join(INSTALLED_APP, 'Contents', 'Resources', 'bin', 'spyly-mcp'))
}

/**
 * Check that the command written down really answers over the protocol.
 *
 * Without this a wrong path looks like "connected", and the agent simply
 * finds nothing, silently.
 */
export async function verifyServer(): Promise<{ ok: boolean; message: string }> {
  const server = serverCommand()
  if (!existsSync(server.command)) {
    return { ok: false, message: t('Не найден файл сервера: {server_command}', { server_command: server.command }) }
  }
  const env = await childEnv()
  return new Promise((resolve) => {
    const child = spawn(server.command, server.args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...env, ...server.env }
    })
    let out = ''
    const done = (ok: boolean, message: string) => {
      child.kill('SIGTERM')
      resolve({ ok, message })
    }
    const timer = setTimeout(() => done(false, t('Сервер не ответил за 10 секунд')), 10_000)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes('"serverInfo"')) {
        clearTimeout(timer)
        done(true, t('Сервер отвечает — всё в порядке'))
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      done(false, t('Не удалось запустить: {error_message}', { error_message: error.message }))
    })
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'spyly', version: '1' } }
      }) + '\n'
    )
  })
}

// ── Claude Desktop: a JSON config ──────────────────────────────────────────

function claudeDesktopConfig(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'Claude', 'claude_desktop_config.json')
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

function claudeDesktopInstalled(): boolean {
  if (process.platform === 'darwin') return existsSync('/Applications/Claude.app')
  return existsSync(claudeDesktopConfig())
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function claudeDesktopConnect(connect: boolean): Promise<AgentActionResult> {
  const file = claudeDesktopConfig()
  const config = await readJson(file)
  if (!config) return { ok: false, message: t('Конфиг Claude Desktop повреждён — поправьте его вручную.') }

  const servers = { ...((config.mcpServers as Record<string, unknown>) ?? {}) }
  if (connect) servers.spyly = serverCommand()
  else delete servers.spyly

  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ ...config, mcpServers: servers }, null, 2), 'utf8')
  return {
    ok: true,
    message: connect
      ? t('Готово. Перезапустите Claude Desktop — и можно спрашивать про свои созвоны.')
      : t('Отключено. Перезапустите Claude Desktop.')
  }
}

async function claudeDesktopConnected(): Promise<boolean> {
  const config = await readJson(claudeDesktopConfig())
  return Boolean(config && (config.mcpServers as Record<string, unknown> | undefined)?.spyly)
}

// ── Claude Code: through its own command ───────────────────────────────────

async function claudeCodeConnected(): Promise<boolean> {
  const binary = await findBinary('claude')
  if (!binary) return false
  try {
    const { stdout } = await run(binary, ['mcp', 'list'], { timeout: 10_000, env: await childEnv() })
    return stdout.includes('spyly')
  } catch {
    return false
  }
}

async function claudeCodeConnect(connect: boolean): Promise<AgentActionResult> {
  const binary = await findBinary('claude')
  if (!binary) return { ok: false, message: t('Claude Code не найден на этом компьютере.') }
  const server = serverCommand()
  try {
    if (connect) {
      // `--scope user` so that calls are visible from any project, not only from
      // the one the command was run in.
      await run(
        binary,
        ['mcp', 'add', 'spyly', '--scope', 'user', '--env', `SPYLY_DIR=${storageRoot()}`, '--', server.command, ...server.args],
        { timeout: 20_000, env: await childEnv() }
      )
      return { ok: true, message: t('Готово. В новых сессиях Claude Code увидит ваши созвоны.') }
    }
    await run(binary, ['mcp', 'remove', 'spyly', '--scope', 'user'], {
      timeout: 20_000,
      env: await childEnv()
    })
    return { ok: true, message: t('Отключено.') }
  } catch (error) {
    return { ok: false, message: `Не получилось: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` }
  }
}

// ── Codex: a section in config.toml ────────────────────────────────────────

function codexConfig(): string {
  return path.join(os.homedir(), '.codex', 'config.toml')
}

async function codexInstalled(): Promise<boolean> {
  return existsSync(path.join(os.homedir(), '.codex')) || (await findBinary('codex')) !== null
}

const CODEX_SECTION = '[mcp_servers.spyly]'

function codexBlock(): string {
  const server = serverCommand()
  const args = server.args.map((a) => `"${a}"`).join(', ')
  const env = Object.entries(server.env)
    .map(([key, value]) => `${key} = "${value}"`)
    .join(', ')
  return [
    CODEX_SECTION,
    `command = "${server.command}"`,
    `args = [${args}]`,
    `env = { ${env} }`
  ].join('\n')
}

/** Cut out the Spyly section without touching the rest of the config. */
function stripCodexSection(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (line.trim() === CODEX_SECTION) {
      skipping = true
      continue
    }
    // The section ends at the next heading in square brackets.
    if (skipping && /^\s*\[/.test(line)) skipping = false
    if (!skipping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

async function codexConnected(): Promise<boolean> {
  const file = codexConfig()
  if (!existsSync(file)) return false
  try {
    return (await readFile(file, 'utf8')).includes(CODEX_SECTION)
  } catch {
    return false
  }
}

async function codexConnect(connect: boolean): Promise<AgentActionResult> {
  const file = codexConfig()
  await mkdir(path.dirname(file), { recursive: true })
  const existing = existsSync(file) ? await readFile(file, 'utf8') : ''
  const cleaned = stripCodexSection(existing)

  if (!connect) {
    await writeFile(file, cleaned + '\n', 'utf8')
    return { ok: true, message: t('Отключено.') }
  }

  const next = cleaned ? `${cleaned}\n\n${codexBlock()}\n` : `${codexBlock()}\n`
  await writeFile(file, next, 'utf8')
  return { ok: true, message: t('Готово. Codex увидит ваши созвоны в новых сессиях.') }
}

// ── the shared interface ───────────────────────────────────────────────────

export async function agentStatuses(): Promise<AgentStatus[]> {
  const claudeCodeBinary = await findBinary('claude')
  const codexReady = await codexInstalled()
  return [
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      installed: claudeDesktopInstalled(),
      connected: await claudeDesktopConnected(),
      hint: claudeDesktopInstalled() ? undefined : t('приложение не найдено')
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      installed: claudeCodeBinary !== null,
      connected: await claudeCodeConnected(),
      hint: claudeCodeBinary ? undefined : t('команда claude не найдена')
    },
    {
      id: 'codex',
      name: 'Codex',
      installed: codexReady,
      connected: await codexConnected(),
      hint: codexReady ? undefined : t('Codex не найден')
    }
  ]
}

export async function setAgentConnection(id: AgentId, connect: boolean): Promise<AgentActionResult> {
  const result =
    id === 'claude-desktop'
      ? await claudeDesktopConnect(connect)
      : id === 'claude-code'
        ? await claudeCodeConnect(connect)
        : await codexConnect(connect)

  if (result.ok && connect && runningFromTemporaryLocation()) {
    return {
      ...result,
      message:
        result.message +
        t(' Внимание: Spyly запущен не из «Программ», и путь к нему может смениться — перенесите приложение в «Программы» и подключите заново.')
    }
  }
  return result
}

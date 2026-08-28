import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Поиск команд, установленных пользователем.
 *
 * Приложение, запущенное из Dock, получает от системы куцый PATH: в нём нет ни
 * homebrew, ни npm-global, ни менеджеров версий node. Поэтому `codex`,
 * поставленный через `npm install -g`, для приложения просто не существует —
 * хотя в терминале работает.
 *
 * Спрашиваем PATH у самой оболочки пользователя и отдельно обходим известные
 * места установки: nvm и fnm держат бинарники в папке конкретной версии, а её
 * имя заранее неизвестно.
 */

/** PATH из оболочки входа: считается один раз, дальше берётся отсюда. */
let shellPath: string[] | null = null

async function loadShellPath(): Promise<string[]> {
  if (shellPath) return shellPath
  const shell = process.env.SHELL
  if (!shell || process.platform === 'win32') {
    shellPath = []
    return shellPath
  }

  shellPath = await new Promise<string[]>((resolve) => {
    // Интерактивная оболочка входа читает .zshrc и .bash_profile — именно там
    // менеджеры версий дописывают свои пути.
    const child = execFile(
      shell,
      ['-ilc', 'printf %s "$PATH"'],
      { timeout: 4000, env: { ...process.env, SPYLY_PATH_PROBE: '1' } },
      (error, stdout) => {
        if (error && !stdout) {
          resolve([])
          return
        }
        resolve(stdout.trim().split(path.delimiter).filter(Boolean))
      }
    )
    child.on('error', () => resolve([]))
  })
  return shellPath
}

/** Папки версий node: имя версии заранее неизвестно, поэтому смотрим все. */
function versionManagerDirs(): string[] {
  const home = os.homedir()
  const out: string[] = []

  const roots: [string, (version: string) => string][] = [
    [path.join(home, '.nvm', 'versions', 'node'), (v) => path.join(v, 'bin')],
    [path.join(home, '.fnm', 'node-versions'), (v) => path.join(v, 'installation', 'bin')],
    [path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), (v) => path.join(v, 'installation', 'bin')],
    [path.join(home, '.local', 'share', 'fnm', 'node-versions'), (v) => path.join(v, 'installation', 'bin')],
    [path.join(home, '.asdf', 'installs', 'nodejs'), (v) => path.join(v, 'bin')]
  ]

  for (const [root, toBin] of roots) {
    if (!existsSync(root)) continue
    try {
      // Свежие версии вперёд: если стоит несколько, команда обычно в последней.
      const versions = readdirSync(root).sort().reverse()
      for (const version of versions) out.push(toBin(path.join(root, version)))
    } catch {
      // Папку могли снести прямо сейчас — не повод падать.
    }
  }
  return out
}

function fixedDirs(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.claude', 'local'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.deno', 'bin'),
    path.join(home, 'node_modules', '.bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ]
}

const cache = new Map<string, string | null>()

/**
 * Путь к команде или null.
 *
 * Результат запоминаем: поиск идёт по десяткам папок, а спрашивают о командах
 * на каждом открытии настроек.
 */
export async function findBinary(name: string): Promise<string | null> {
  const hit = cache.get(name)
  if (hit !== undefined) return hit

  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    ...(await loadShellPath()),
    ...fixedDirs(),
    ...versionManagerDirs()
  ]

  let found: string | null = null
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) {
      found = candidate
      break
    }
  }

  cache.set(name, found)
  return found
}

/**
 * PATH для дочернего процесса.
 *
 * Мало найти команду — её ещё надо суметь запустить. `codex` начинается с
 * `#!/usr/bin/env node`, и если в PATH дочернего процесса нет самого node,
 * запуск падает с «env: node: No such file or directory». У приложения из Dock
 * такого PATH как раз и нет, поэтому собираем его сами — из тех же папок, где
 * искали команду.
 */
export async function enrichedPath(): Promise<string> {
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    ...(await loadShellPath()),
    ...fixedDirs(),
    ...versionManagerDirs()
  ].filter(Boolean)
  return [...new Set(dirs)].join(path.delimiter)
}

/** Забыть найденное — после установки команды искать надо заново. */
export function forgetBinaries(): void {
  cache.clear()
  shellPath = null
}

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Finding commands the user has installed.
 *
 * An application started from the Dock gets a threadbare PATH from the system:
 * no homebrew, no npm-global, none of the node version managers. So `codex`
 * installed through `npm install -g` simply does not exist as far as the app
 * is concerned, even though it works in a terminal.
 *
 * We ask the user's own shell for its PATH and separately walk the known
 * install locations: nvm and fnm keep their binaries in a folder named after a
 * particular version, and that name is not known in advance.
 */

/** PATH from the login shell: computed once, then taken from here. */
let shellPath: string[] | null = null

async function loadShellPath(): Promise<string[]> {
  if (shellPath) return shellPath
  const shell = process.env.SHELL
  if (!shell || process.platform === 'win32') {
    shellPath = []
    return shellPath
  }

  shellPath = await new Promise<string[]>((resolve) => {
    // An interactive login shell reads .zshrc and .bash_profile, which is exactly
    // where version managers add their paths.
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

/** Node version folders: the version name is not known in advance, so look at all of them. */
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
      // Newer versions first: with several installed, the command is usually in the last one.
      const versions = readdirSync(root).sort().reverse()
      for (const version of versions) out.push(toBin(path.join(root, version)))
    } catch {
      // The folder may have been removed just now, which is no reason to fail.
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
 * The path to a command, or null.
 *
 * The result is remembered: the search walks dozens of folders, and commands
 * are asked about every time settings are opened.
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
 * PATH for a child process.
 *
 * Finding the command is not enough, it also has to be possible to run it.
 * `codex` starts with `#!/usr/bin/env node`, and if node itself is not in the
 * child's PATH the launch fails with "env: node: No such file or directory".
 * An app started from the Dock has no such PATH, so we assemble one ourselves,
 * out of the same folders the command was looked for in.
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

/** Forget what was found: after a command is installed it has to be looked for again. */
export function forgetBinaries(): void {
  cache.clear()
  shellPath = null
}

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * whisper.cpp for local transcription.
 *
 * The sources do not live in this repository: it is a separate project with its
 * own history and licence, and it weighs close to a hundred megabytes. Instead
 * of a copy there is a clone at a pinned commit: the build is reproducible, and
 * updating to a new version comes down to changing one line here.
 */

const REPO = 'https://github.com/ggml-org/whisper.cpp.git'
/** The commit that was verified: whisper-cli, whisper-server and parakeet-cli all build on it. */
const COMMIT = '9781133'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'native', 'whisper')

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

if (existsSync(path.join(dir, 'CMakeLists.txt'))) {
  process.stdout.write(`whisper.cpp is already in place: ${dir}\n`)
  process.exit(0)
}

process.stdout.write(`Cloning whisper.cpp into ${dir}\n`)
run('git', ['clone', '--filter=blob:none', REPO, dir], root)
run('git', ['checkout', '--detach', COMMIT], dir)
process.stdout.write('Done\n')

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * whisper.cpp для локальной расшифровки.
 *
 * Исходники не лежат в репозитории: это отдельный проект со своей историей и
 * лицензией, а весит он под сотню мегабайт. Вместо копии — клон на закреплённом
 * коммите: сборка воспроизводится, а обновление до новой версии сводится к
 * замене одной строки здесь.
 */

const REPO = 'https://github.com/ggml-org/whisper.cpp.git'
/** Проверенный коммит: на нём собираются whisper-cli, whisper-server и parakeet-cli. */
const COMMIT = '9781133'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'native', 'whisper')

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

if (existsSync(path.join(dir, 'CMakeLists.txt'))) {
  process.stdout.write(`whisper.cpp уже на месте: ${dir}\n`)
  process.exit(0)
}

process.stdout.write(`Клонирую whisper.cpp в ${dir}\n`)
run('git', ['clone', '--filter=blob:none', REPO, dir], root)
run('git', ['checkout', '--detach', COMMIT], dir)
process.stdout.write('Готово\n')

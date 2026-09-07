import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, constants, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, net } from 'electron'

/**
 * Installing an update ourselves.
 *
 * Squirrel, which electron-updater hands the work to on macOS, verifies that
 * the new bundle carries the same signature as the running one, and refuses
 * otherwise. Without a Developer ID certificate every build is signed ad-hoc,
 * the signature is a hash of the contents, and no two builds ever agree — so
 * Squirrel refuses every time, and it refuses while downloading, not while
 * installing, which is why nothing at all appeared to happen.
 *
 * So the archive is fetched and put in place here instead. What Squirrel
 * guaranteed by the signature is replaced by the checksum from the release: the
 * update description is fetched from GitHub over TLS and names the sha512 of
 * every file, and an archive that does not match it is not unpacked.
 *
 * The price of an ad-hoc signature is paid all the same, only later: macOS ties
 * the granted permissions to the signature, a new build has a different one,
 * and the microphone and system audio have to be allowed again. That is said
 * out loud before anything is downloaded.
 */

const run = promisify(execFile)

/** The bundle we are running out of: /Applications/Spyly.app, normally. */
function bundlePath(): string {
  // .../Spyly.app/Contents/MacOS/Spyly
  return path.resolve(path.dirname(app.getPath('exe')), '..', '..')
}

/**
 * Where updates come from, as electron-builder wrote it into the bundle.
 *
 * Two lines of YAML are read with a regular expression rather than a parser:
 * the file is generated, its shape is fixed, and a parser in the main process
 * would be a dependency bought for nothing.
 */
async function feed(): Promise<{ owner: string; repo: string } | null> {
  try {
    const text = await readFile(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
    const owner = /^owner:\s*(\S+)\s*$/m.exec(text)?.[1]
    const repo = /^repo:\s*(\S+)\s*$/m.exec(text)?.[1]
    return owner && repo ? { owner, repo } : null
  } catch {
    return null
  }
}

/** Read one key out of a bundle's Info.plist. */
async function plist(bundle: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await run('/usr/bin/defaults', ['read', path.join(bundle, 'Contents', 'Info'), key])
    return stdout.trim()
  } catch {
    return null
  }
}

/** Download to a file, reporting how far along it is. */
async function download(url: string, to: string, onProgress: (percent: number) => void): Promise<void> {
  const response = await net.fetch(url)
  if (!response.ok || !response.body) throw new Error(`${response.status} on ${url}`)

  const total = Number(response.headers.get('content-length')) || 0
  const file = createWriteStream(to)
  const reader = response.body.getReader()
  let got = 0
  let shown = -1
  // A write that fails — a full disk, most likely — never drains, and waiting
  // for a drain that will not come is a download that hangs for good.
  let broken: Error | null = null
  file.on('error', (error: Error) => {
    broken = error
  })

  try {
    for (;;) {
      if (broken) throw broken
      const { done, value } = await reader.read()
      if (done) break
      // Wait for the file to take it before asking for more. Without this a
      // hundred and fifty megabytes pile up in memory whenever the disk is
      // slower than the network.
      if (!file.write(value)) await Promise.race([once(file, 'drain'), once(file, 'error')])
      got += value.length
      if (!total) continue
      const percent = Math.floor((got / total) * 100)
      // Only on a change, or the renderer is woken for every packet.
      if (percent !== shown) {
        shown = percent
        onProgress(percent)
      }
    }
    if (broken) throw broken
    await new Promise<void>((resolve, reject) => {
      file.on('error', reject)
      file.end(() => resolve())
    })
  } catch (error) {
    file.destroy()
    throw error
  }
}

/** The sha512 of a file, in the base64 the release description uses. */
async function checksum(file: string): Promise<string> {
  const hash = createHash('sha512')
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject)
  })
  return hash.digest('base64')
}

/**
 * Fetch the update and unpack it, leaving the running application untouched.
 *
 * Returns the unpacked bundle, ready to be put in place. Everything that can
 * fail — the network, the checksum, the archive — fails here, while the
 * installed application is still whole.
 */
export async function fetchUpdate(
  version: string,
  file: { url: string; sha512: string },
  onProgress: (percent: number) => void
): Promise<string> {
  const where = await feed()
  if (!where) throw new Error('this build carries no update settings')

  const staging = await mkdtemp(path.join(os.tmpdir(), 'spyly-update-'))
  const archive = path.join(staging, path.basename(file.url))
  // The tag is how release-please names it, and how the release holding this
  // very description is named: the update file was fetched from the same place.
  const url = `https://github.com/${where.owner}/${where.repo}/releases/download/v${version}/${file.url}`

  try {
    await download(url, archive, onProgress)

    const got = await checksum(archive)
    if (got !== file.sha512) throw new Error('the downloaded file does not match the release')

    // ditto, not unzip: it keeps symlinks, permissions and the signature, and a
    // bundle unpacked any other way will not start.
    await run('/usr/bin/ditto', ['-x', '-k', archive, staging])

    // Looked for rather than assumed: a person may have renamed the installed
    // application, and the archive always carries the name it was built with.
    const bundle = (await readdir(staging)).find((name) => name.endsWith('.app'))
    if (!bundle) throw new Error('the downloaded archive holds no application')

    const current = bundlePath()
    const unpacked = path.join(staging, bundle)
    const identity = await plist(unpacked, 'CFBundleIdentifier')
    if (!identity || identity !== (await plist(current, 'CFBundleIdentifier'))) {
      throw new Error('the downloaded archive holds a different application')
    }
    if ((await plist(unpacked, 'CFBundleShortVersionString')) !== version) {
      throw new Error('the downloaded archive holds a different version')
    }
    return unpacked
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

/** Throw away what was fetched: the update is not going to be installed after all. */
export async function discardUpdate(unpacked: string): Promise<void> {
  await rm(path.dirname(unpacked), { recursive: true, force: true })
}

/**
 * Put the unpacked bundle in place of the running one and start it again.
 *
 * The application cannot replace itself while it is running, so the swap is
 * left to a small script that waits for this process to end. The old bundle is
 * moved aside rather than deleted: if the copy fails there is something to put
 * back, and a person is left with a working application rather than none.
 */
export async function applyUpdate(unpacked: string): Promise<void> {
  const target = bundlePath()
  // Checked before anything is quit: replacing the bundle means renaming it
  // inside its own directory, and an application installed somewhere we cannot
  // write to would be quit for nothing and left for the person to start again.
  await access(path.dirname(target), constants.W_OK)
  const staging = path.dirname(unpacked)
  // In a directory of its own: the script removes the staging directory when it
  // is done, and bash reads a script as it goes — deleting it mid-run is asking
  // for a swap that stops halfway.
  const script = path.join(await mkdtemp(path.join(os.tmpdir(), 'spyly-swap-')), 'swap.sh')

  await writeFile(
    script,
    `#!/bin/bash
target=${JSON.stringify(target)}
staged=${JSON.stringify(unpacked)}
pid=${process.pid}

# Twenty seconds is far longer than quitting takes; past that something is
# wrong and replacing the bundle underneath a live process would be worse.
for _ in $(seq 1 200); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
kill -0 "$pid" 2>/dev/null && exit 1

backup="$target.replaced"
rm -rf "$backup"
# From here on the application is closed and its bundle is being moved about.
# Every way out of this starts it again: a failed update must cost a restart,
# never the application itself.
if ! mv "$target" "$backup"; then
  /usr/bin/open "$target"
  exit 1
fi
if ! /usr/bin/ditto "$staged" "$target"; then
  rm -rf "$target"
  mv "$backup" "$target"
  /usr/bin/open "$target"
  exit 1
fi
# Downloaded by us rather than by a browser, so there should be no quarantine
# flag on it — but an application that will not open is not worth the risk.
/usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null
rm -rf "$backup"
/usr/bin/open "$target"
rm -rf ${JSON.stringify(staging)}
# Last of all, and with exec: this script sits in that directory, bash reads a
# script as it runs, and exec is the point past which it reads no more.
exec /bin/rm -rf ${JSON.stringify(path.dirname(script))}
`,
    { mode: 0o755 }
  )

  // Detached and with no streams of its own: it has to outlive the process that
  // started it, which is the whole point of it.
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}

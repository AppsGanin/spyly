import { existsSync } from 'node:fs'
import path from 'node:path'
import { t } from '@spyly/core'
import { app, dialog, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { send } from './index.js'
import { applyUpdate, discardUpdate, fetchUpdate } from './update-install.js'

/**
 * Updating from GitHub releases.
 *
 * The check is quiet: nobody is disturbed until there is something to say. When
 * there is, we ask first and only then download — an update is a hundred and
 * fifty megabytes and a restart, and neither should happen behind a person's
 * back. Interrupting a recording with an update is unacceptable under any
 * circumstances, so while recording we do not even ask.
 *
 * The download and the swap are ours rather than Squirrel's: see
 * `update-install.ts` for why, and for what it costs.
 */

const { autoUpdater } = electronUpdater

/** Every six hours: no reason for more, releases do not come out that fast. */
const CHECK_EVERY_MS = 6 * 60 * 60_000

const RELEASES_URL = 'https://github.com/AppsGanin/spyly/releases/latest'

/**
 * Whether this copy knows where its updates come from.
 *
 * electron-builder writes `app-update.yml` into the bundle only for a real
 * installer — a `--dir` build, the kind made to try something out quickly, does
 * not get one. Without the file electron-updater throws a plain ENOENT with the
 * full path in it, and that is what a person saw instead of an answer. The file
 * is looked for directly rather than the error read afterwards: the question
 * "can this build update itself" has an answer before anything is attempted.
 */
function canUpdate(): boolean {
  return app.isPackaged && existsSync(path.join(process.resourcesPath, 'app-update.yml'))
}

let timer: ReturnType<typeof setInterval> | null = null
let busy = false
let recording: () => boolean = () => false

export function startUpdates(isRecording: () => boolean): void {
  // In development, and in a build made without an installer, there is nowhere
  // to update from; extra requests to GitHub only get in the way.
  if (!canUpdate()) return

  recording = isRecording
  // Squirrel is never given the file: it checks the signature as it downloads,
  // and an ad-hoc signed build never passes that check.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('error', (error: Error) => {
    // An update is not something worth disturbing a person with a dialog over. It
    // goes into the log, so that silence can be looked into.
    process.stderr.write(`[update] ${error.message}\n`)
  })

  const check = (): void => {
    void checkForUpdatesNow()
  }

  // The first check is deferred: there is enough going on at startup without it.
  setTimeout(check, 30_000).unref?.()
  timer = setInterval(check, CHECK_EVERY_MS)
  timer.unref?.()
}

export function stopUpdates(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/**
 * Ask, then fetch, then put in place.
 *
 * Runs on its own: the check that started it has already answered, and this
 * takes as long as the download does.
 */
async function offer(version: string, files: { url: string; sha512: string }[]): Promise<void> {
  if (busy || recording()) return
  // The zip is the one holding the application itself; the disk image would
  // have to be mounted first, and gains nothing for it.
  const file = files.find((it) => it.url.endsWith('.zip'))
  if (!file) return
  busy = true

  try {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: t('Есть новая версия'),
      message: t('Spyly {version}', { version }),
      detail: t(
        'Скачаем обновление и перезапустим приложение. После этого macOS заново спросит доступ к микрофону и системному звуку: сборка не подписана сертификатом разработчика, и система видит в ней новое приложение.'
      ),
      buttons: [t('Обновить'), t('Потом')],
      defaultId: 0,
      cancelId: 1
    })
    if (response !== 0) return

    send('toast', { kind: 'info', text: t('Скачиваю Spyly {version}', { version }) })
    const unpacked = await fetchUpdate(version, file, (percent) => send('update:progress', { percent }))

    // A recording may have started while it was downloading. The update waits:
    // it will be found again at the next check.
    if (recording()) {
      await discardUpdate(unpacked)
      send('toast', { kind: 'info', text: t('Обновление отложено до конца записи') })
      return
    }
    await applyUpdate(unpacked)
  } catch (error) {
    process.stderr.write(`[update] ${error instanceof Error ? error.message : String(error)}\n`)
    send('toast', { kind: 'error', text: t('Не удалось обновиться. Можно скачать вручную в «Все версии»') })
  } finally {
    busy = false
    send('update:progress', { percent: null })
  }
}

/** Check at a person's request and report what was found. */
export async function checkForUpdatesNow(): Promise<
  | { state: 'current'; version: string }
  | { state: 'found'; version: string }
  | { state: 'unsupported' }
  | { state: 'failed'; hint: string }
> {
  if (!app.isPackaged) return { state: 'current', version: app.getVersion() }
  if (!canUpdate()) return { state: 'unsupported' }
  try {
    const found = await autoUpdater.checkForUpdates()
    const version = found?.updateInfo.version
    if (version && version !== app.getVersion()) {
      // The offer runs on its own: this answer is what the button is waiting for.
      void offer(version, found!.updateInfo.files)
      return { state: 'found', version }
    }
    return { state: 'current', version: app.getVersion() }
  } catch (error) {
    return { state: 'failed', hint: error instanceof Error ? error.message : String(error) }
  }
}

export function openReleases(): void {
  void shell.openExternal(RELEASES_URL)
}

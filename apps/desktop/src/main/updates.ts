import { t } from '@spyly/core'
import { app, dialog, shell } from 'electron'
import electronUpdater from 'electron-updater'

/**
 * Updating from GitHub releases.
 *
 * The check is quiet: until an update has downloaded, nobody is disturbed. Once
 * it is ready we ask whether to install now or at the next launch. Interrupting
 * a recording with an update is unacceptable under any circumstances, so while
 * recording we do not even ask.
 *
 * On macOS an update only installs if the application is signed with a
 * Developer ID certificate: Squirrel checks the signature before installing. An
 * application built without a certificate works but will not update itself, and
 * then a link to the releases page is what is left.
 */

const { autoUpdater } = electronUpdater

/** Every six hours: no reason for more, releases do not come out that fast. */
const CHECK_EVERY_MS = 6 * 60 * 60_000

const RELEASES_URL = 'https://github.com/AppsGanin/spyly/releases/latest'

let timer: ReturnType<typeof setInterval> | null = null
let asked = false

export function startUpdates(isRecording: () => boolean): void {
  // In development there is nowhere to update from, and extra requests to GitHub only get in the way.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  // Installed only once a person has agreed: a silent restart in the middle of
  // work is the worst thing an application that records conversations can do.
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', (info) => {
    if (asked || isRecording()) return
    asked = true
    void dialog
      .showMessageBox({
        type: 'info',
        title: t('Обновление готово'),
        message: t('Spyly {info_version} скачан', { info_version: info.version }),
        detail: t('Поставить сейчас — приложение перезапустится. Или оно поставится при следующем запуске.'),
        buttons: [t('Поставить сейчас'), t('Потом')],
        defaultId: 0,
        cancelId: 1
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
  })

  autoUpdater.on('error', (error: Error) => {
    // An update is not something worth disturbing a person with a dialog over. It
    // goes into the log, so that silence can be looked into.
    process.stderr.write(`[обновление] ${error.message}\n`)
  })

  const check = (): void => {
    if (isRecording()) return
    void autoUpdater.checkForUpdates().catch(() => undefined)
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

/** Check at a person's request and report what was found. */
export async function checkForUpdatesNow(): Promise<
  { state: 'current'; version: string } | { state: 'found'; version: string } | { state: 'failed'; hint: string }
> {
  if (!app.isPackaged) return { state: 'current', version: app.getVersion() }
  try {
    const found = await autoUpdater.checkForUpdates()
    const version = found?.updateInfo.version
    if (version && version !== app.getVersion()) return { state: 'found', version }
    return { state: 'current', version: app.getVersion() }
  } catch (error) {
    return { state: 'failed', hint: error instanceof Error ? error.message : String(error) }
  }
}

export function openReleases(): void {
  void shell.openExternal(RELEASES_URL)
}

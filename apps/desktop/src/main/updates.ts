import { t } from '@spyly/core'
import { app, dialog, shell } from 'electron'
import electronUpdater from 'electron-updater'

/**
 * Обновление из релизов на GitHub.
 *
 * Проверка тихая: пока обновление не скачалось, человека не трогаем. Когда оно
 * готово — спрашиваем, ставить сейчас или при следующем запуске. Прерывать
 * идущую запись обновлением нельзя ни при каких условиях, поэтому во время
 * записи мы даже не спрашиваем.
 *
 * На macOS обновление ставится, только если приложение подписано сертификатом
 * Developer ID: Squirrel проверяет подпись перед установкой. Собранное без
 * сертификата приложение работает, но обновляться само не будет — тогда
 * остаётся ссылка на страницу релизов.
 */

const { autoUpdater } = electronUpdater

/** Раз в шесть часов: чаще незачем, релизы выходят не так быстро. */
const CHECK_EVERY_MS = 6 * 60 * 60_000

const RELEASES_URL = 'https://github.com/AppsGanin/spyly/releases/latest'

let timer: ReturnType<typeof setInterval> | null = null
let asked = false

export function startUpdates(isRecording: () => boolean): void {
  // В разработке обновляться неоткуда, а лишние запросы к GitHub только мешают.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  // Ставим только когда человек согласился: тихий перезапуск посреди работы —
  // худшее, что может сделать приложение, которое пишет разговоры.
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
    // Обновление — не то, из-за чего стоит беспокоить человека окном. В журнал
    // пишем, чтобы разобраться, если оно молчит.
    process.stderr.write(`[обновление] ${error.message}\n`)
  })

  const check = (): void => {
    if (isRecording()) return
    void autoUpdater.checkForUpdates().catch(() => undefined)
  }

  // Первую проверку откладываем: при запуске и без неё есть чем заняться.
  setTimeout(check, 30_000).unref?.()
  timer = setInterval(check, CHECK_EVERY_MS)
  timer.unref?.()
}

export function stopUpdates(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Проверить по просьбе человека и ответить, что нашлось. */
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

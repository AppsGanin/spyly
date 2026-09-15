import { t } from '@spyly/core'

/**
 * What a failed update check means, in words.
 *
 * electron-updater hands back its own message with the URL, the response
 * headers and a stack trace glued in, and that is what a person used to see in
 * a toast half a screen tall. The full text still goes to the log; the screen
 * gets what happened and what to do about it.
 */
export interface UpdateProblem {
  text: string
  /**
   * Info when it will pass by itself, and nothing is wrong with the app or the
   * connection: a release whose files are still being uploaded.
   */
  tone: 'info' | 'error'
}

const OFFLINE =
  /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|CONNECTION_\w+|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_\w+)|\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN)\b/

export function describeUpdateError(error: unknown): UpdateProblem {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code
  const status = (error as { statusCode?: unknown } | null)?.statusCode

  // First, because electron-updater wraps a lost connection into "cannot find
  // the latest version", and that would read as though there were no releases.
  if (OFFLINE.test(message)) {
    return { text: t('Нет связи с GitHub — проверьте интернет и попробуйте ещё раз'), tone: 'error' }
  }

  // A release is published before its build is uploaded into it, and for the
  // few minutes in between the list of files is simply not there yet.
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_ZIP_FILE_NOT_FOUND') {
    const version = /\/download\/v?(\d+\.\d+\.\d+[\w.-]*)\//.exec(message)?.[1]
    return {
      text: version
        ? t('Spyly {version} уже вышла, но файлы ещё загружаются — проверьте через несколько минут', { version })
        : t('Новая версия уже вышла, но файлы ещё загружаются — проверьте через несколько минут'),
      tone: 'info'
    }
  }

  if (status === 403 || status === 429 || /HttpError: (403|429)\b|rate limit/i.test(message)) {
    return { text: t('GitHub временно ограничил запросы — попробуйте позже'), tone: 'error' }
  }

  if ((typeof status === 'number' && status >= 500) || /HttpError: 5\d\d\b/.test(message)) {
    return { text: t('GitHub сейчас не отвечает — попробуйте позже'), tone: 'error' }
  }

  return {
    text: t('Не получилось проверить обновления. Новую версию можно скачать вручную в «Все версии»'),
    tone: 'error'
  }
}

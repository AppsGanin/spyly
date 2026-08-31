import { useState } from 'react'
import { api, useIpcEvent } from '../lib/api'
import { useStore } from '../lib/store'
import { Button, Modal } from '../ui'
import { t } from '@spyly/core'

/**
 * An offer to record a conversation that has been noticed.
 *
 * A dialog rather than a silent auto-start: an application that begins
 * recording a conversation by itself is exactly what people fear from software
 * like this.
 */
export function CallPrompt() {
  const { settings, recording, notify } = useStore()
  const [app, setApp] = useState<string | null>(null)

  useIpcEvent('call:detected', ({ app: detected }) => {
    if (settings?.autoDetectCalls !== 'notify') return
    if (recording.status === 'recording' || recording.status === 'paused') return
    setApp(detected)
  })

  const start = async () => {
    setApp(null)
    try {
      await api.call('rec:start', {
        mic: true,
        system: true,
        title: app ? t('Запись · {app}', { app: app }) : undefined
      })
      notify('success', t('Запись началась'))
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Modal
      open={app !== null}
      onClose={() => setApp(null)}
      title={t('Похоже, начался разговор')}
      actions={
        <>
          <Button onClick={() => setApp(null)}>{t('Не сейчас')}</Button>
          <Button variant="primary" onClick={() => void start()}>{t('Записать')}</Button>
        </>
      }
    >
      <p className="muted">
        {app
          ? t('{app} слушает микрофон.', { app: app })
          : t('Микрофон занят другим приложением. Обычно так начинается разговор.')}{' '}
        {t('После остановки появится расшифровка и конспект.')}
      </p>
      <p className="check__hint">{t('Подсказку можно отключить в настройках, в разделе «Замечать начало разговора».')}</p>
    </Modal>
  )
}

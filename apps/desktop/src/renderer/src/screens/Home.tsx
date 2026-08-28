import { t } from '@spyly/core'
import { useEffect, useState } from 'react'
import { IconRecord, IconSparkle } from '../lib/icons'
import { useStore } from '../lib/store'
import { Button, EmptyState } from '../ui'
import { StartDialog } from '../components/StartDialog'

/**
 * Экран без выбранной встречи.
 *
 * Список записей живёт в боковой панели и повторять его в центре незачем:
 * здесь нужно либо объяснить, с чего начать, либо просто не мешать.
 */
export function Home({ openRecord = false }: { openRecord?: boolean } = {}) {
  const { meetings, notify, recording } = useStore()
  const [startOpen, setStartOpen] = useState(false)

  useEffect(() => {
    if (openRecord) setStartOpen(true)
  }, [openRecord])
  const isRecording = recording.status === 'recording' || recording.status === 'paused'

  return (
    <>
      <div className="main__header" />

      {meetings.length === 0 ? (
        <EmptyState
          icon={<IconSparkle size={22} />}
          title={t('Здесь пока пусто')}
          text={t('Включите запись перед звонком в любом приложении. Когда остановите, появится расшифровка по участникам и конспект.')}
          action={
            !isRecording && (
              <Button variant="primary" size="lg" onClick={() => setStartOpen(true)}>
                <IconRecord />{t('Начать первую запись')}</Button>
            )
          }
        />
      ) : (
        <EmptyState
          icon={<IconSparkle size={22} />}
          title={t('Выберите запись')}
          text={t('Откройте запись слева, чтобы прочитать конспект и расшифровку.')}
        />
      )}

      <StartDialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        onStarted={() => {
          setStartOpen(false)
          notify('success', t('Запись началась'))
        }}
      />
    </>
  )
}

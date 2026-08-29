import { t } from '@spyly/core'
import { useEffect, useState } from 'react'
import { IconRecord, IconSparkle } from '../lib/icons'
import { useStore } from '../lib/store'
import { Button, EmptyState } from '../ui'
import { StartDialog } from '../components/StartDialog'

/**
 * The screen with no meeting selected.
 *
 * The list of recordings lives in the sidebar and there is no reason to repeat
 * it in the middle: here we either explain where to start, or simply stay out
 * of the way.
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

import { t } from '@spyly/core'
import { useEffect, useMemo, useState } from 'react'
import { api, useIpcEvent } from './lib/api'
import { startCapture, stopCapture } from './lib/capture'
import { useShortcuts } from './lib/shortcuts'
import { CallPrompt } from './components/CallPrompt'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { Home } from './screens/Home'
import { MeetingView } from './screens/MeetingView'
import { Onboarding } from './screens/Onboarding'
import { SettingsScreen } from './screens/Settings'
import { useStore } from './lib/store'

export default function App() {
  const { settings, view, setView, recording, meetings } = useStore()
  const [restored, setRestored] = useState(false)

  // Пока настройки не загрузились, рисовать нечего: тема и состояние
  // онбординга приходят оттуда, и мелькание экрана было бы заметно.
  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    if (settings.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', settings.theme)
  }, [settings])

  const [debugRecord, setDebugRecord] = useState(false)
  const [debugTab, setDebugTab] = useState<string | undefined>()
  useIpcEvent('view:meeting', ({ id }) => {
    setRestored(true)
    setView({ kind: 'meeting', id })
  })

  // Захват звука на Windows и Linux живёт в окне: главный процесс просит
  // открыть поток, а куски уходят обратно через IPC.
  useIpcEvent('capture:start', ({ track, micDeviceId }) => {
    void (async () => {
      const result = await startCapture(
        { mic: track === 'mic', system: track === 'system', micDeviceId },
        (id, samples) => {
          // Отдаём копию буфера: исходный переиспользуется под следующий кусок.
          void api.call('capture:samples', id, samples.buffer.slice(0) as ArrayBuffer)
        }
      )
      const ok = track === 'mic' ? result.mic : result.system
      if (ok) void api.call('capture:ready', track)
      else void api.call('capture:failed', track, result.errors.join('; ') || t('не удалось открыть поток'))
    })()
  })

  useIpcEvent('capture:stop', () => {
    void stopCapture()
  })

  useIpcEvent('debug:view', ({ kind, tab }) => {
    setRestored(true)
    setDebugTab(tab)
    if (kind === 'record') {
      setView({ kind: 'home' })
      setDebugRecord(true)
      return
    }
    if (kind === 'settings') setView({ kind: 'settings' })
    else if (kind === 'meeting') {
      // Проверочным прогонам нужна самая свежая запись: только на её странице
      // видно расшифровку, конспект и панель экспорта.
      void api.call('meetings:list').then((list) => {
        if (list[0]) setView({ kind: 'meeting', id: list[0].id })
      })
    } else setView({ kind: 'home' })
  })

  // При запуске открываем последнюю встречу: пустой экран при непустом
  // списке — лишний клик на ровном месте.
  useEffect(() => {
    if (restored || meetings.length === 0 || view.kind !== 'home') return
    setRestored(true)
    setView({ kind: 'meeting', id: meetings[0]!.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetings.length, restored])

  // Начавшаяся запись открывает свою встречу с любого экрана: там идёт живая
  // расшифровка, и искать её вручную пользователь не должен.
  useEffect(() => {
    if (recording.status !== 'recording' || !recording.meetingId) return
    if (view.kind === 'meeting' && view.id === recording.meetingId) return
    setView({ kind: 'meeting', id: recording.meetingId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.status, recording.meetingId])

  // Клавиши окна: запись, поиск и настройки — то, к чему тянутся чаще всего.
  useShortcuts(
    useMemo(
      () => [
        {
          key: 'r',
          meta: true,
          run: () => {
            if (recording.status === 'recording' || recording.status === 'paused') void api.call('rec:stop')
            else window.dispatchEvent(new CustomEvent('spyly:start-recording'))
          }
        },
        {
          key: 'm',
          meta: true,
          run: () => {
            if (recording.status === 'recording' || recording.status === 'paused') {
              window.dispatchEvent(new CustomEvent('spyly:mark'))
            }
          }
        },
        { key: 'f', meta: true, run: () => window.dispatchEvent(new CustomEvent('spyly:focus-search')) },
        { key: ',', meta: true, run: () => setView({ kind: 'settings' }) }
      ],
      [recording.status, setView]
    )
  )

  if (!settings) return <div className="app" />

  if (!settings.onboardingDone) {
    return (
      <>
        <div className="titlebar" />
        <Onboarding />
        <Toasts />
      </>
    )
  }

  return (
    <>
      <div className="titlebar" />
      <div className="app">
        <Sidebar />
        <main className="main">
          {view.kind === 'home' && <Home openRecord={debugRecord} />}
          {view.kind === 'meeting' && <MeetingView id={view.id} initialTab={debugTab} />}
          {view.kind === 'settings' && <SettingsScreen initialTab={debugTab} />}
        </main>
      </div>
      <CallPrompt />
      <Toasts />
    </>
  )
}

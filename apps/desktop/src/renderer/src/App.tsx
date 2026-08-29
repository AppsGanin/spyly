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

  // Until the settings have loaded there is nothing to draw: the theme and the
  // onboarding state come from there, and a flash of the screen would be noticeable.
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

  // Audio capture on Windows and Linux lives in the window: the main process asks
  // for a stream to be opened, and the chunks go back over IPC.
  useIpcEvent('capture:start', ({ track, micDeviceId }) => {
    void (async () => {
      const result = await startCapture(
        { mic: track === 'mic', system: track === 'system', micDeviceId },
        (id, samples) => {
          // A copy of the buffer is handed over: the original is reused for the next chunk.
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
      // Test runs need the most recent recording: its page is the only place showing
      // the transcript, the summary and the export bar.
      void api.call('meetings:list').then((list) => {
        if (list[0]) setView({ kind: 'meeting', id: list[0].id })
      })
    } else setView({ kind: 'home' })
  })

  // At startup the last meeting is opened: an empty screen with a non-empty list
  // is one click wasted for nothing.
  useEffect(() => {
    if (restored || meetings.length === 0 || view.kind !== 'home') return
    setRestored(true)
    setView({ kind: 'meeting', id: meetings[0]!.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetings.length, restored])

  // A recording that has started opens its own meeting from any screen: live
  // transcription runs there, and the user should not have to go looking for it.
  useEffect(() => {
    if (recording.status !== 'recording' || !recording.meetingId) return
    if (view.kind === 'meeting' && view.id === recording.meetingId) return
    setView({ kind: 'meeting', id: recording.meetingId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.status, recording.meetingId])

  // Window shortcuts: recording, search and settings, the things reached for most often.
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

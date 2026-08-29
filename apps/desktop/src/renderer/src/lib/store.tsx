import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { t, containment, type MeetingMeta } from '@spyly/core'
import type { LiveUtterance, RecordingState, Settings, StageProgress } from '@shared/ipc'
import { api, useIpcEvent } from './api'

export type View =
  | { kind: 'home' }
  | { kind: 'meeting'; id: string }
  | { kind: 'settings' }

interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

interface Store {
  settings: Settings | null
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  recording: RecordingState
  meetings: MeetingMeta[]
  reloadMeetings: () => Promise<void>
  view: View
  setView: (view: View) => void
  toasts: Toast[]
  notify: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: number) => void
  /** Processing progress per meeting, shown right in the list. */
  progress: Record<string, StageProgress>
  levels: { mic: number; system: number }
  /** Draft utterances of the current recording: shown while it runs. */
  live: LiveUtterance[]
}

const StoreContext = createContext<Store | null>(null)

const idleRecording: RecordingState = {
  status: 'idle',
  meetingId: null,
  startedAt: null,
  elapsedSec: 0,
  levels: { mic: 0, system: 0 },
  tracks: { mic: false, system: false },
  error: null
}

let toastId = 0

export function StoreProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [recording, setRecording] = useState<RecordingState>(idleRecording)
  const [meetings, setMeetings] = useState<MeetingMeta[]>([])
  const [view, setView] = useState<View>({ kind: 'home' })
  const [toasts, setToasts] = useState<Toast[]>([])
  const [progress, setProgress] = useState<Record<string, StageProgress>>({})
  const [levels, setLevels] = useState({ mic: 0, system: 0 })
  const [live, setLive] = useState<LiveUtterance[]>([])

  const notify = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastId
    setToasts((prev) => [...prev, { id, kind, text }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  /**
   * A rejection nobody caught.
   *
   * There are dozens of actions in the interface, and wrapping each of them in
   * try/catch is a sure way to forget one day. Here everything is caught at once:
   * a button that silently did nothing is worse than an error message.
   */
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason
      const text = reason instanceof Error ? reason.message : String(reason)
      // Aborted requests are not an error: that is how stale loads are cancelled.
      if (/abort|cancell?ed/i.test(text)) return
      event.preventDefault()
      notify('error', text.replace(/^Error invoking remote method '[^']+':\s*/, ''))
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [notify])

  const reloadMeetings = useCallback(async () => {
    const list = await api.call('meetings:list')
    setMeetings(list)
  }, [])

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await api.call('settings:set', patch)
    setSettings(next)
  }, [])

  useEffect(() => {
    void (async () => {
      const [loadedSettings, state] = await Promise.all([api.call('settings:get'), api.call('rec:state')])
      // The language takes effect on the window's next render, so if the cache has
      // fallen behind the settings we update it and reload once.
      try {
        if (localStorage.getItem('spyly.lang') !== loadedSettings.uiLang) {
          localStorage.setItem('spyly.lang', loadedSettings.uiLang)
          location.reload()
          return
        }
      } catch {
        // Private mode: the language will stay as already applied.
      }
      setSettings(loadedSettings)
      setRecording(state)
      await reloadMeetings()
    })()
  }, [reloadMeetings])

  useIpcEvent('rec:state', (next) => {
    setRecording((prev) => {
      // A new recording: old drafts have nothing to do with it.
      if (next.meetingId !== prev.meetingId) setLive([])
      return next
    })
  })
  useIpcEvent('live:utterance', (utterance) => {
    setLive((prev) => {
      // Empty text is a request to remove an utterance: its ending turned out to be
      // echo or invention, and it no longer belongs on screen.
      if (!utterance.text) return prev.filter((u) => u.id !== utterance.id)

      // The streaming model sends a growing phrase many times under one `id`: this is
      // not a new utterance but a refinement of one already shown.
      const known = prev.findIndex((u) => u.id === utterance.id)
      if (known !== -1) {
        const next = [...prev]
        next[known] = utterance
        return next
      }

      // Without headphones the microphone hears the other side through the speakers,
      // and one phrase arrives twice, from both tracks. The other side's track is
      // cleaner, so on a match that is the one kept. Only finished phrases are
      // compared: a growing one is still changing, and a match there means nothing.
      if (utterance.final) {
        const near = prev.filter(
          (u) => u.final && u.track !== utterance.track && Math.abs(u.start - utterance.start) < 4
        )
        const duplicate = near.find((u) => containment(utterance.text, u.text) >= 0.7)
        if (duplicate) {
          if (utterance.track === 'system' && duplicate.track === 'mic') {
            return [...prev.filter((u) => u.id !== duplicate.id), utterance].sort((a, b) => a.start - b.start)
          }
          return prev
        }
      }
      return [...prev, utterance].sort((a, b) => a.start - b.start)
    })
  })
  useIpcEvent('audio:levels', setLevels)
  useIpcEvent('toast', ({ kind, text }) => notify(kind, text))
  useIpcEvent('meetings:changed', () => void reloadMeetings())
  useIpcEvent('stage:progress', (payload) => {
    setProgress((prev) => ({ ...prev, [payload.meetingId]: payload }))
  })

  const value = useMemo<Store>(
    () => ({
      settings,
      saveSettings,
      recording,
      meetings,
      reloadMeetings,
      view,
      setView,
      toasts,
      notify,
      dismissToast,
      progress,
      levels,
      live
    }),
    [
      settings,
      saveSettings,
      recording,
      meetings,
      reloadMeetings,
      view,
      toasts,
      notify,
      dismissToast,
      progress,
      levels,
      live
    ]
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error(t('useStore вызван вне StoreProvider'))
  return store
}

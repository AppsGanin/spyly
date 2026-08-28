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
  /** Прогресс обработки по встречам — показывается прямо в списке. */
  progress: Record<string, StageProgress>
  levels: { mic: number; system: number }
  /** Черновые реплики текущей записи: показываются, пока идёт запись. */
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
   * Отказ, который никто не поймал.
   *
   * Действий в интерфейсе десятки, и оборачивать каждое в try/catch — верный
   * способ однажды забыть. Здесь ловим всё разом: молчаливо не сработавшая
   * кнопка хуже, чем сообщение об ошибке.
   */
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason
      const text = reason instanceof Error ? reason.message : String(reason)
      // Отменённые запросы — не ошибка: так гасятся устаревшие загрузки.
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
      // Язык применяется при следующей отрисовке окна, поэтому если кэш отстал
      // от настроек — обновляем его и перезагружаемся один раз.
      try {
        if (localStorage.getItem('spyly.lang') !== loadedSettings.uiLang) {
          localStorage.setItem('spyly.lang', loadedSettings.uiLang)
          location.reload()
          return
        }
      } catch {
        // Приватный режим — язык останется тем, что уже применён.
      }
      setSettings(loadedSettings)
      setRecording(state)
      await reloadMeetings()
    })()
  }, [reloadMeetings])

  useIpcEvent('rec:state', (next) => {
    setRecording((prev) => {
      // Новая запись — старые черновики к ней отношения не имеют.
      if (next.meetingId !== prev.meetingId) setLive([])
      return next
    })
  })
  useIpcEvent('live:utterance', (utterance) => {
    setLive((prev) => {
      // Пустой текст — просьба убрать реплику: её окончание оказалось эхом
      // или выдумкой, и на экране ей больше не место.
      if (!utterance.text) return prev.filter((u) => u.id !== utterance.id)

      // Потоковая модель присылает растущую фразу много раз под одним `id`:
      // это не новая реплика, а уточнение уже показанной.
      const known = prev.findIndex((u) => u.id === utterance.id)
      if (known !== -1) {
        const next = [...prev]
        next[known] = utterance
        return next
      }

      // Без наушников микрофон слышит собеседника из колонок, и одна фраза
      // приходит дважды — с обеих дорожек. Дорожка собеседников чище, поэтому
      // при совпадении оставляем её. Сверяем только договорённые: у растущей
      // фразы текст ещё меняется, и совпадение здесь ничего не значит.
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

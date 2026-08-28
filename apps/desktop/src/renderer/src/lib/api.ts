import { useCallback, useEffect, useRef, useState } from 'react'
import type { IpcChannel, IpcEventName, IpcEvents, IpcRequests } from '@shared/ipc'

export const api = {
  call<C extends IpcChannel>(channel: C, ...args: Parameters<IpcRequests[C]>): Promise<ReturnType<IpcRequests[C]>> {
    return window.spyly.invoke(channel, ...args)
  },
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
    return window.spyly.on(event, listener)
  }
}

/** Подписка на событие из main без утечки слушателей при перерисовке. */
export function useIpcEvent<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): void {
  const ref = useRef(listener)
  ref.current = listener
  useEffect(() => api.on(event, (payload) => ref.current(payload)), [event])
}

interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

/**
 * Загрузка данных из main.
 *
 * Ответ на устаревший запрос отбрасывается: при быстрой смене встреч ответы
 * приходят вразнобой, и без этого в интерфейс попадала бы чужая расшифровка.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null })
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setState((prev) => ({ ...prev, loading: true, error: null }))
    load()
      .then((data) => {
        if (generation.current === current) setState({ data, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (generation.current !== current) return
        const message = error instanceof Error ? error.message : String(error)
        setState({ data: null, loading: false, error: message })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, reload }
}

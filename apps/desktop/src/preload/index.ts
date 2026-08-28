import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel, IpcEventName, IpcEvents, IpcRequests } from '../shared/ipc.js'

/**
 * Мост между процессами.
 *
 * Renderer не получает ни Node, ни ipcRenderer напрямую: только вызов по имени
 * канала и подписка на события. Валидация аргументов — на стороне main.
 */
const api = {
  invoke<C extends IpcChannel>(channel: C, ...args: Parameters<IpcRequests[C]>): Promise<ReturnType<IpcRequests[C]>> {
    return ipcRenderer.invoke(channel, ...args) as Promise<ReturnType<IpcRequests[C]>>
  },
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
    const wrapped = (_e: unknown, payload: IpcEvents[E]) => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.off(event, wrapped)
  }
}

contextBridge.exposeInMainWorld('spyly', api)

export type SpylyApi = typeof api

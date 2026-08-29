import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel, IpcEventName, IpcEvents, IpcRequests } from '../shared/ipc.js'

/**
 * The bridge between the processes.
 *
 * The renderer gets neither Node nor ipcRenderer directly: only a call by
 * channel name and a subscription to events. Argument validation lives on the
 * main side.
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

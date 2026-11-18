/**
 * The one and only preload. Runs sandboxed: it may only require('electron').
 * Exposes a typed, allow-listed API as `window.api`.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { ipcChannels, ipcEventNames, type EventName, type IpcEvents } from '../shared/ipc-contract'
import type { Api } from '../shared/api'

const allowedChannels = new Set<string>(ipcChannels)
const allowedEvents = new Set<string>(ipcEventNames)

const api: Api = {
  invoke(channel, ...args) {
    if (!allowedChannels.has(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, args[0])
  },

  on<E extends EventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
    if (!allowedEvents.has(event)) throw new Error(`Unknown IPC event: ${event}`)
    const wrapped = (_e: IpcRendererEvent, payload: IpcEvents[E]) => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  },

  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)

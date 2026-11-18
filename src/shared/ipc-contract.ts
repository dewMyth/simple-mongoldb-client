/**
 * The single source of truth for every IPC channel.
 *
 * Each channel declares a zod schema for its input (validated in main before the handler runs)
 * and a phantom output type. The preload exposes `window.api.invoke(channel, input)` typed from
 * this table, so main and renderer can never drift apart.
 *
 * Adding a channel: add it here, register a handler in src/main/ipc, and write a test.
 */
import { z } from 'zod'

/** Declares a channel: zod input schema + output type carried only at the type level. */
function channel<I extends z.ZodType, O>(input: I): { input: I; output: O } {
  return { input, output: undefined as unknown as O }
}

// ---------------------------------------------------------------- shared schemas

export const themeSchema = z.enum(['light', 'dark', 'system'])
export type Theme = z.infer<typeof themeSchema>

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
}

export interface Settings {
  theme: Theme
}

// ---------------------------------------------------------------- the contract

export const ipcContract = {
  'app:info': channel<z.ZodVoid, AppInfo>(z.void()),
  'app:openExternal': channel<z.ZodString, void>(z.string().url()),

  'settings:get': channel<z.ZodVoid, Settings>(z.void()),
  'settings:setTheme': channel<typeof themeSchema, Settings>(themeSchema)
} as const

export type IpcContract = typeof ipcContract
export type Channel = keyof IpcContract
export type ChannelInput<C extends Channel> = z.input<IpcContract[C]['input']>
export type ChannelOutput<C extends Channel> = IpcContract[C]['output']

export const ipcChannels = Object.keys(ipcContract) as Channel[]

// ---------------------------------------------------------------- transport envelope

/**
 * Errors thrown with ipcMain.handle lose everything but the message, so handlers return an
 * envelope instead and the preload re-throws an IpcError carrying the server error code.
 */
export interface SerializedError {
  message: string
  name: string
  /** MongoServerError numeric code, e.g. 13 = Unauthorized, 50 = MaxTimeMSExpired. */
  code?: number
  codeName?: string
  /** Set by validation failures in the IPC layer itself. */
  validation?: boolean
}

export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: SerializedError }

export class IpcError extends Error {
  readonly code?: number
  readonly codeName?: string
  readonly validation?: boolean
  constructor(err: SerializedError) {
    super(err.message)
    this.name = err.name || 'IpcError'
    this.code = err.code
    this.codeName = err.codeName
    this.validation = err.validation
  }
}

/** Push events from main → renderer (subscriptions via window.api.on). */
export interface IpcEvents {
  'settings:changed': Settings
}
export type EventName = keyof IpcEvents
export const ipcEventNames: EventName[] = ['settings:changed']

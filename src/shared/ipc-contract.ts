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
import {
  connectionDraftSchema,
  type ActiveConnection,
  type CollectionInfo,
  type DatabaseInfo,
  type SavedConnection,
  type ServerInfo
} from './connection'

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

const connId = z.string().min(1)
const dbName = z.string().min(1).max(64)
const collName = z.string().min(1).max(255)

export const createCollectionSchema = z.object({
  connectionId: connId,
  db: dbName,
  name: collName,
  capped: z
    .object({ size: z.number().int().positive(), max: z.number().int().positive().optional() })
    .optional(),
  timeseries: z
    .object({
      timeField: z.string().min(1),
      metaField: z.string().optional(),
      granularity: z.enum(['seconds', 'minutes', 'hours']).optional()
    })
    .optional(),
  clusteredIndex: z.boolean().optional()
})

export const openFileSchema = z.object({
  title: z.string().optional(),
  filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })).optional()
})

// ---------------------------------------------------------------- the contract

export const ipcContract = {
  'app:info': channel<z.ZodVoid, AppInfo>(z.void()),
  'app:openExternal': channel<z.ZodString, void>(z.string().url()),

  'settings:get': channel<z.ZodVoid, Settings>(z.void()),
  'settings:setTheme': channel<typeof themeSchema, Settings>(themeSchema),

  'dialog:openFile': channel<typeof openFileSchema, string | null>(openFileSchema),

  'connections:list': channel<z.ZodVoid, SavedConnection[]>(z.void()),
  'connections:save': channel<typeof connectionDraftSchema, SavedConnection>(connectionDraftSchema),
  'connections:delete': channel<typeof connId, void>(connId),
  /** Test an unsaved draft (stored secrets are reused when the draft has an id). */
  'connections:test': channel<typeof connectionDraftSchema, ServerInfo>(connectionDraftSchema),
  'connections:connect': channel<typeof connId, ActiveConnection>(connId),
  'connections:disconnect': channel<typeof connId, void>(connId),
  'connections:active': channel<z.ZodVoid, ActiveConnection[]>(z.void()),

  'db:listDatabases': channel<typeof connId, DatabaseInfo[]>(connId),
  'db:listCollections': channel<
    z.ZodObject<{ connectionId: typeof connId; db: typeof dbName }>,
    CollectionInfo[]
  >(z.object({ connectionId: connId, db: dbName })),
  'db:createCollection': channel<typeof createCollectionSchema, void>(createCollectionSchema),
  'db:dropCollection': channel<
    z.ZodObject<{ connectionId: typeof connId; db: typeof dbName; name: typeof collName }>,
    void
  >(z.object({ connectionId: connId, db: dbName, name: collName })),
  'db:dropDatabase': channel<z.ZodObject<{ connectionId: typeof connId; db: typeof dbName }>, void>(
    z.object({ connectionId: connId, db: dbName })
  )
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
  'connections:activeChanged': ActiveConnection[]
}
export type EventName = keyof IpcEvents
export const ipcEventNames: EventName[] = ['settings:changed', 'connections:activeChanged']

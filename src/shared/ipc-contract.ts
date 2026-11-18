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
import {
  queryFields,
  queryTextSchema,
  type CountResult,
  type FavoriteQuery,
  type FindPage,
  type FindResult,
  type HistoryEntry,
  type QueryFieldError
} from './query'
import type { PermissionSnapshot } from './permissions'
import type { FieldStat } from './field-stats'

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

const nsSchema = z.string().regex(/^[^.]+\..+$/, 'Namespace must be "db.collection"')
const nsTarget = z.object({ connectionId: connId, ns: nsSchema })
const objectQueryField = z.enum(['filter', 'project', 'sort', 'collation'])

export const findSchema = z.object({
  connectionId: connId,
  ns: nsSchema,
  tabId: z.string().nullable().default(null),
  query: queryTextSchema,
  batchSize: z.number().int().min(1).max(10_000).optional(),
  /** Page window over the user's skip/limit; the page arrives in one batch (no cursor left open). */
  page: z.object({ offset: z.number().int().min(0), size: z.number().int().min(1).max(1000) }).optional()
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
  /** Toggle the read-only override; applies immediately to an open connection. */
  'connections:setReadOnly': channel<
    z.ZodObject<{ id: typeof connId; readOnly: z.ZodBoolean }>,
    SavedConnection
  >(z.object({ id: connId, readOnly: z.boolean() })),
  'permissions:get': channel<typeof connId, PermissionSnapshot | null>(connId),

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
  ),

  'query:validate': channel<
    z.ZodObject<{ field: z.ZodEnum<{ [K in (typeof queryFields)[number]]: K }>; text: z.ZodString }>,
    QueryFieldError | null
  >(z.object({ field: z.enum(queryFields), text: z.string().max(1_000_000) })),
  'query:format': channel<z.ZodObject<{ field: typeof objectQueryField; text: z.ZodString }>, string | null>(
    z.object({ field: objectQueryField, text: z.string().max(1_000_000) })
  ),
  'query:find': channel<typeof findSchema, FindResult>(findSchema),
  'query:getMore': channel<z.ZodObject<{ cursorId: z.ZodString; count: z.ZodNumber }>, FindPage>(
    z.object({ cursorId: z.string().min(1), count: z.number().int().min(1).max(10_000) })
  ),
  'query:count': channel<typeof findSchema, CountResult>(findSchema),
  /** Cancels a cursor/operation by id. Returns false if it had already finished. */
  /** $sample the collection and summarise field paths/types (table columns, autocomplete). */
  'schema:sampleFields': channel<
    z.ZodObject<{
      connectionId: typeof connId
      ns: typeof nsSchema
      tabId: z.ZodOptional<z.ZodNullable<z.ZodString>>
      size: z.ZodOptional<z.ZodNumber>
    }>,
    { sampled: number; fields: FieldStat[] }
  >(
    z.object({
      connectionId: connId,
      ns: nsSchema,
      tabId: z.string().nullable().optional(),
      size: z.number().int().min(1).max(10_000).optional()
    })
  ),
  'ops:cancel': channel<z.ZodString, boolean>(z.string().min(1)),
  /** Kills every cursor and operation owned by a tab (Esc, or the tab was closed). */
  'ops:cancelForTab': channel<z.ZodString, number>(z.string().min(1)),

  'history:list': channel<typeof nsTarget, HistoryEntry[]>(nsTarget),
  'history:add': channel<
    z.ZodObject<{ connectionId: typeof connId; ns: typeof nsSchema; query: typeof queryTextSchema }>,
    HistoryEntry[]
  >(nsTarget.extend({ query: queryTextSchema })),
  'history:clear': channel<typeof nsTarget, void>(nsTarget),
  'favorites:list': channel<z.ZodOptional<typeof nsSchema>, FavoriteQuery[]>(nsSchema.optional()),
  'favorites:save': channel<
    z.ZodObject<{
      id: z.ZodOptional<z.ZodString>
      name: z.ZodString
      ns: typeof nsSchema
      query: typeof queryTextSchema
    }>,
    FavoriteQuery
  >(z.object({ id: z.string().optional(), name: z.string().max(200), ns: nsSchema, query: queryTextSchema })),
  'favorites:delete': channel<z.ZodString, void>(z.string().min(1))
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
  'permissions:changed': PermissionSnapshot
}
export type EventName = keyof IpcEvents
export const ipcEventNames: EventName[] = [
  'settings:changed',
  'connections:activeChanged',
  'permissions:changed'
]

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
  type QueryFieldError,
  type RecentQuery
} from './query'
import { workspaceSchema, type Workspace } from './workspace'
import { createIndexSchema, type IndexBuild, type IndexInfo } from './indexes'
import { explainSourceSchema, type ExplainResult } from './explain'
import type { ShellEvalResult, ShellSessionInfo } from './shell'
import type { SchemaResult } from './schema'
import {
  exportStartSchema,
  importStartSchema,
  type ChosenFile,
  type ImportPreview,
  type JobProgress
} from './import-export'
import {
  pipelineOptionsSchema,
  pipelineStageSchema,
  stageInputSchema,
  type PipelineRunResult,
  type SavedPipeline,
  type StagePreview
} from './pipeline'
import type { PermissionSnapshot } from './permissions'
import type { FieldStat } from './field-stats'
import type { InsertResult, ParseDocumentsResult, UpdatePreview, UpdateResult } from './documents'
import { exportLanguages } from './code-export'

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

export const convertSchema = z.object({
  field: objectQueryField,
  text: z.string().max(1_000_000),
  to: z.enum(['shell', 'canonical', 'relaxed'])
})

export const exportCodeSchema = z.object({
  ns: nsSchema,
  query: queryTextSchema,
  language: z.enum(exportLanguages),
  mode: z.enum(['find', 'count'])
})

const aggTarget = z.object({ connectionId: connId, ns: nsSchema, tabId: z.string().nullable().optional() })
const stageList = z.array(stageInputSchema).max(500)
export const aggPreviewSchema = aggTarget.extend({
  stages: stageList,
  sampleSize: z.number().int().min(1).max(1000),
  options: pipelineOptionsSchema,
  lastOnly: z.boolean().optional()
})
export const aggRunSchema = aggTarget.extend({ stages: stageList, options: pipelineOptionsSchema })
export const aggCreateViewSchema = z.object({
  connectionId: connId,
  ns: nsSchema,
  name: collName,
  stages: stageList
})
export const aggExportSchema = z.object({
  ns: nsSchema,
  stages: stageList,
  options: pipelineOptionsSchema,
  language: z.enum(exportLanguages)
})
export const pipelineSaveSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(200),
  ns: nsSchema,
  stages: z.array(pipelineStageSchema.omit({ id: true })).max(500),
  options: pipelineOptionsSchema
})

const indexTarget = z.object({ connectionId: connId, ns: nsSchema })
export const indexCreateSchema = indexTarget.extend({ form: createIndexSchema })
export const indexNameSchema = indexTarget.extend({ name: z.string().min(1).max(400) })
export const indexHiddenSchema = indexNameSchema.extend({ hidden: z.boolean() })
export const explainRunSchema = indexTarget.extend({
  tabId: z.string().nullable().optional(),
  source: explainSourceSchema
})

export const shellStartSchema = z.object({
  connectionId: connId,
  tabId: z.string().min(1),
  db: z.string().max(64).nullable().optional()
})
const sessionId = z.string().min(1).max(100)
export const shellCodeSchema = z.object({ sessionId, code: z.string().max(5_000_000) })

export const schemaAnalyzeSchema = z.object({
  connectionId: connId,
  ns: nsSchema,
  tabId: z.string().nullable().optional(),
  sampleSize: z.number().int().min(1).max(100_000),
  filter: z.string().max(1_000_000)
})
export const setFilterFieldSchema = z.object({
  filter: z.string().max(1_000_000),
  path: z.string().min(1).max(1000),
  valueText: z.string().max(100_000)
})
const fileToken = z.string().min(1).max(100)

export type ExportCodeResult = { ok: true; code: string } | { ok: false; errors: QueryFieldError[] }

export const findSchema = z.object({
  connectionId: connId,
  ns: nsSchema,
  tabId: z.string().nullable().default(null),
  query: queryTextSchema,
  batchSize: z.number().int().min(1).max(10_000).optional(),
  /** Page window over the user's skip/limit; the page arrives in one batch (no cursor left open). */
  page: z.object({ offset: z.number().int().min(0), size: z.number().int().min(1).max(1000) }).optional()
})

/** One BSON document (≤ 16 MB, plus headroom). */
const bsonBytes = z
  .instanceof(Uint8Array)
  .refine((b) => b.byteLength <= 17 * 1024 * 1024, 'Document too large')
const docTarget = z.object({ connectionId: connId, ns: nsSchema })
export const docUpdateSchema = docTarget.extend({
  original: bsonBytes,
  edited: bsonBytes,
  force: z.boolean().optional()
})
export const docInsertSchema = docTarget.extend({ docs: z.array(bsonBytes).min(1).max(100_000) })
export const docDeleteOneSchema = docTarget.extend({ original: bsonBytes })
export const docManySchema = docTarget.extend({ query: queryTextSchema })
export const docUpdateManySchema = docManySchema.extend({ update: z.string().min(1).max(1_000_000) })

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
  /** Rewrites query text as shell syntax / canonical EJSON / relaxed EJSON. Null if it doesn't parse. */
  'query:convert': channel<typeof convertSchema, string | null>(convertSchema),
  /** The query as runnable driver code. Never includes the connection string. */
  'query:exportCode': channel<typeof exportCodeSchema, ExportCodeResult>(exportCodeSchema),
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
      maxValues: z.ZodOptional<z.ZodNumber>
    }>,
    { sampled: number; fields: FieldStat[] }
  >(
    z.object({
      connectionId: connId,
      ns: nsSchema,
      tabId: z.string().nullable().optional(),
      size: z.number().int().min(1).max(10_000).optional(),
      maxValues: z.number().int().min(1).max(200).optional()
    })
  ),
  /** Parse shell-syntax text into BSON documents (one or an array). */
  'docs:parse': channel<z.ZodString, ParseDocumentsResult>(z.string().max(20_000_000)),
  /** Conflict-safe single-document save (changed paths only, original values in the filter). */
  'docs:update': channel<typeof docUpdateSchema, UpdateResult>(docUpdateSchema),
  'docs:insert': channel<typeof docInsertSchema, InsertResult>(docInsertSchema),
  'docs:deleteOne': channel<typeof docDeleteOneSchema, { deleted: boolean }>(docDeleteOneSchema),
  'docs:deleteMany': channel<typeof docManySchema, { deletedCount: number }>(docManySchema),
  'docs:updateMany': channel<typeof docUpdateManySchema, { matchedCount: number; modifiedCount: number }>(
    docUpdateManySchema
  ),
  /** Before/after of the first 5 matching documents. Never writes. */
  'docs:previewUpdate': channel<typeof docUpdateManySchema, UpdatePreview>(docUpdateManySchema),
  /** The output of the pipeline up to each stage (sampled). Never runs $out/$merge. */
  'agg:preview': channel<typeof aggPreviewSchema, StagePreview[]>(aggPreviewSchema),
  /** Runs the whole pipeline (permission-checked when it ends in $out/$merge). */
  'agg:run': channel<typeof aggRunSchema, PipelineRunResult>(aggRunSchema),
  'agg:createView': channel<typeof aggCreateViewSchema, string>(aggCreateViewSchema),
  'agg:exportCode': channel<
    typeof aggExportSchema,
    { ok: true; code: string } | { ok: false; message: string }
  >(aggExportSchema),
  /** Syntax check for one stage body (live squiggles). Null when it parses. */
  'agg:validateStage': channel<typeof stageInputSchema, QueryFieldError | null>(stageInputSchema),
  'pipelines:list': channel<typeof nsSchema, SavedPipeline[]>(nsSchema),
  'pipelines:save': channel<typeof pipelineSaveSchema, SavedPipeline>(pipelineSaveSchema),
  'pipelines:delete': channel<z.ZodString, void>(z.string().min(1)),
  'indexes:list': channel<typeof indexTarget, IndexInfo[]>(indexTarget),
  /** Index builds in progress on the collection (from $currentOp; empty without access). */
  'indexes:builds': channel<typeof indexTarget, IndexBuild[]>(indexTarget),
  /** Creates an index (returns its name once built). */
  'indexes:create': channel<typeof indexCreateSchema, string>(indexCreateSchema),
  'indexes:drop': channel<typeof indexNameSchema, void>(indexNameSchema),
  'indexes:setHidden': channel<typeof indexHiddenSchema, void>(indexHiddenSchema),
  /** explain("executionStats") for a find or a pipeline, analysed (summary, tree, hints). */
  'explain:run': channel<typeof explainRunSchema, ExplainResult>(explainRunSchema),
  /** Starts (or resumes) the tab's mongosh session. Credentials never leave main. */
  'shell:start': channel<typeof shellStartSchema, ShellSessionInfo>(shellStartSchema),
  'shell:evaluate': channel<typeof shellCodeSchema, ShellEvalResult>(shellCodeSchema),
  /** Ctrl+C: interrupts the running command and kills its server-side operation. */
  'shell:interrupt': channel<typeof sessionId, boolean>(sessionId),
  'shell:complete': channel<typeof shellCodeSchema, string[]>(shellCodeSchema),
  'shell:close': channel<typeof sessionId, void>(sessionId),
  /** Schema tab: analyse a sample (optionally filtered) with types, presence and charts. */
  'schema:analyze': channel<typeof schemaAnalyzeSchema, SchemaResult>(schemaAnalyzeSchema),
  /** Sets (or toggles off) one field in filter text. Null if the filter doesn't parse. */
  'query:setFilterField': channel<typeof setFilterFieldSchema, string | null>(setFilterFieldSchema),

  /** Native save dialog; main remembers the path and returns a token for export:start. */
  'files:chooseExport': channel<z.ZodObject<{ defaultName: z.ZodString }>, ChosenFile | null>(
    z.object({ defaultName: z.string().min(1).max(255) })
  ),
  /** Native open dialog; main remembers the path and returns a token for import. */
  'files:chooseImport': channel<z.ZodVoid, ChosenFile | null>(z.void()),
  'export:start': channel<typeof exportStartSchema, JobProgress>(exportStartSchema),
  'import:preview': channel<
    z.ZodObject<{ token: typeof fileToken; format: z.ZodOptional<z.ZodEnum<{ json: 'json'; csv: 'csv' }>> }>,
    ImportPreview
  >(z.object({ token: fileToken, format: z.enum(['json', 'csv']).optional() })),
  /** Starts an import (permission-checked: insert on the target collection). */
  'import:start': channel<typeof importStartSchema, JobProgress>(importStartSchema),
  'jobs:cancel': channel<z.ZodString, boolean>(z.string().min(1)),
  /** Shows a finished export's file in the OS file manager. */
  'jobs:reveal': channel<z.ZodString, void>(z.string().min(1)),
  'ops:cancel': channel<z.ZodString, boolean>(z.string().min(1)),
  /** Kills every cursor and operation owned by a tab (Esc, or the tab was closed). */
  'ops:cancelForTab': channel<z.ZodString, number>(z.string().min(1)),

  'history:list': channel<typeof nsTarget, HistoryEntry[]>(nsTarget),
  'history:add': channel<
    z.ZodObject<{ connectionId: typeof connId; ns: typeof nsSchema; query: typeof queryTextSchema }>,
    HistoryEntry[]
  >(nsTarget.extend({ query: queryTextSchema })),
  'history:clear': channel<typeof nsTarget, void>(nsTarget),
  /** Most recent queries across namespaces, optionally only for some connections (command palette). */
  'history:recent': channel<
    z.ZodObject<{ limit: z.ZodOptional<z.ZodNumber>; connectionIds: z.ZodOptional<z.ZodArray<z.ZodString>> }>,
    RecentQuery[]
  >(
    z.object({
      limit: z.number().int().min(1).max(200).optional(),
      connectionIds: z.array(z.string().min(1)).max(100).optional()
    })
  ),

  /** Open tabs, their queries and the split view, restored on the next start (never re-run). */
  'workspace:get': channel<z.ZodVoid, Workspace | null>(z.void()),
  'workspace:save': channel<typeof workspaceSchema, void>(workspaceSchema),
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
  /** Text printed by a running shell command (print(), console.log…). */
  'shell:output': { sessionId: string; text: string }
  /** Import/export progress (throttled) and completion. */
  'jobs:progress': JobProgress
}
export type EventName = keyof IpcEvents
export const ipcEventNames: EventName[] = [
  'settings:changed',
  'connections:activeChanged',
  'permissions:changed',
  'shell:output',
  'jobs:progress'
]

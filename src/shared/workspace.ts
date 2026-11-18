/**
 * The tab workspace as persisted to disk (main validates it on save and on load, so a corrupt
 * or hand-edited file can't break startup). Queries are restored but never re-run automatically.
 */
import { z } from 'zod'
import { queryTextSchema } from './query'
import { pipelineStateSchema } from './pipeline'

export const tabTypes = [
  'documents',
  'aggregation',
  'indexes',
  'schema',
  'explain',
  'shell',
  'import-export',
  'connection-info'
] as const
export type TabType = (typeof tabTypes)[number]

export const viewModes = ['tree', 'json', 'table'] as const
/** How a documents tab renders results. */
export type ViewMode = (typeof viewModes)[number]

export const splitOrientations = ['horizontal', 'vertical'] as const
export type SplitOrientation = (typeof splitOrientations)[number]

export const persistedTabSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(tabTypes),
  connectionId: z.string().min(1).max(100),
  /** "db.collection" for collection tabs; null for connection-level tabs. */
  ns: z.string().max(400).nullable(),
  title: z.string().max(400),
  query: queryTextSchema,
  viewMode: z.enum(viewModes),
  pinned: z.boolean(),
  /** Index of the first visible document when the tab was last shown. */
  scrollAnchor: z.number().int().min(0).max(1_000_000),
  /** Aggregation tabs: the builder's stages, mode and options. */
  pipeline: pipelineStateSchema.optional()
})
export type PersistedTab = z.infer<typeof persistedTabSchema>

export const workspaceSchema = z.object({
  version: z.literal(1),
  tabs: z.array(persistedTabSchema).max(200),
  activeId: z.string().nullable(),
  split: z
    .object({
      tabId: z.string(),
      orientation: z.enum(splitOrientations),
      /** Share of the space taken by the primary (left/top) pane. */
      ratio: z.number().min(0.15).max(0.85)
    })
    .nullable()
})
export type Workspace = z.infer<typeof workspaceSchema>

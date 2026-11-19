/**
 * Import/export: formats, request schemas and job progress. Files are only ever read or written
 * through tokens issued by main's own file dialogs, never by paths sent from the renderer.
 */
import { z } from 'zod'
import type { BsonBytes } from './bson-wire'
import { queryTextSchema } from './query'

export const exportFormats = ['json', 'jsonl', 'csv'] as const
export type ExportFormat = (typeof exportFormats)[number]
export const ejsonModes = ['canonical', 'relaxed'] as const
export type EjsonMode = (typeof ejsonModes)[number]

export const exportFormatLabel: Record<ExportFormat, string> = {
  json: 'JSON array',
  jsonl: 'JSON lines (one document per line)',
  csv: 'CSV'
}

export const csvColumnTypes = [
  'auto',
  'string',
  'int32',
  'int64',
  'double',
  'decimal128',
  'boolean',
  'date',
  'objectId',
  'exclude'
] as const
export type CsvColumnType = (typeof csvColumnTypes)[number]

export const csvColumnTypeLabel: Record<CsvColumnType, string> = {
  auto: 'Detect per value',
  string: 'String',
  int32: 'Int32',
  int64: 'Int64',
  double: 'Double',
  decimal128: 'Decimal128',
  boolean: 'Boolean',
  date: 'Date',
  objectId: 'ObjectId',
  exclude: 'Don’t import'
}

const connectionId = z.string().min(1)
const nsSchema = z.string().regex(/^[^.]+\..+$/)
const token = z.string().min(1).max(100)

export const exportStartSchema = z.object({
  connectionId,
  ns: nsSchema,
  token,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('query'), query: queryTextSchema }),
    z.object({ kind: z.literal('collection') })
  ]),
  format: z.enum(exportFormats),
  ejson: z.enum(ejsonModes),
  /** CSV: dotted field paths, in column order. */
  fields: z.array(z.string().min(1).max(1000)).max(5000).optional()
})
export type ExportStart = z.infer<typeof exportStartSchema>

export const importStartSchema = z.object({
  connectionId,
  ns: nsSchema,
  token,
  format: z.enum(['json', 'csv']),
  /** CSV: a type per column, in header order. */
  columns: z
    .array(z.object({ name: z.string().max(1000), type: z.enum(csvColumnTypes) }))
    .max(5000)
    .optional(),
  /** CSV: leave out empty cells (instead of importing "" strings). */
  ignoreEmpty: z.boolean(),
  stopOnError: z.boolean()
})
export type ImportStart = z.infer<typeof importStartSchema>

export interface ChosenFile {
  token: string
  name: string
  size: number
}

export interface ImportPreview {
  format: 'json' | 'csv'
  name: string
  size: number
  /** JSON: the first documents (BSON). */
  docs: BsonBytes[]
  /** CSV: header, first rows, and a detected type per column. */
  csv: { headers: string[]; rows: string[][]; detected: CsvColumnType[] } | null
  errors: string[]
}

export interface JobProgress {
  jobId: string
  kind: 'export' | 'import'
  ns: string
  /** File name only (the full path stays in main). */
  file: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  /** Documents written (export) or read (import). */
  processed: number
  /** Expected documents (export), if known. */
  total: number | null
  /** Bytes written (export) or read (import). */
  bytes: number
  /** Import: file size. */
  totalBytes: number | null
  inserted: number
  failed: number
  /** The first errors (import), for the summary. */
  errors: string[]
  message: string | null
}

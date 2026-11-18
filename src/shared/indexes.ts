/**
 * Index model for the Indexes tab: classification of listIndexes specs into the kinds the UI
 * shows (single, compound, multikey, text, 2dsphere, hashed, wildcard, TTL, partial, unique,
 * sparse, hidden…), plus the create-index form schema.
 */
import { z } from 'zod'

export const indexKinds = [
  'single',
  'compound',
  'multikey',
  'text',
  '2dsphere',
  '2d',
  'hashed',
  'wildcard',
  'clustered',
  'ttl',
  'partial',
  'unique',
  'sparse',
  'hidden',
  'collation'
] as const
export type IndexKind = (typeof indexKinds)[number]

export interface IndexField {
  field: string
  /** 1, -1, "text", "2dsphere", "hashed"… as displayed. */
  value: string
}

export interface IndexInfo {
  name: string
  fields: IndexField[]
  /** The key pattern in shell syntax. */
  keyText: string
  kinds: IndexKind[]
  /** null when it couldn't be determined (hidden, text, wildcard and geo indexes). */
  multikey: boolean | null
  /** Bytes on disk (null without collStats access). */
  size: number | null
  /** Operations that used the index since `since` (from $indexStats; null without access). */
  usage: { ops: number; since: number } | null
  ttlSeconds: number | null
  partialFilterText: string | null
  collationText: string | null
  wildcardProjectionText: string | null
  /** Text indexes: weighted fields. */
  weightsText: string | null
  /** The whole spec in shell syntax. */
  specText: string
}

export interface IndexBuild {
  indexes: string[]
  message: string
  done: number | null
  total: number | null
}

type Doc = Record<string, unknown>

const numeric = (v: unknown): number | null => {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && 'valueOf' in v) {
    const n = Number((v as { valueOf(): unknown }).valueOf())
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Display value of one key: numbers as 1 / -1 (whatever their BSON type), strings as-is. */
export function keyValueText(v: unknown): string {
  const n = numeric(v)
  if (n !== null) return String(n)
  return String(v)
}

/** Classifies a listIndexes spec (multikey comes separately: it needs the planner). */
export function classifyIndex(spec: Doc, multikey: boolean | null): IndexKind[] {
  const key = (spec.key ?? {}) as Doc
  const entries = Object.entries(key)
  const values = entries.map(([, v]) => v)
  const kinds: IndexKind[] = []
  if (spec.clustered) kinds.push('clustered')
  if (values.includes('text') || spec.textIndexVersion !== undefined) kinds.push('text')
  if (values.includes('2dsphere')) kinds.push('2dsphere')
  if (values.includes('2d')) kinds.push('2d')
  if (values.includes('hashed')) kinds.push('hashed')
  if (entries.some(([k]) => k === '$**' || k.endsWith('.$**'))) kinds.push('wildcard')
  if (!kinds.some((k) => k === 'text' || k === 'wildcard'))
    kinds.unshift(entries.length > 1 ? 'compound' : 'single')
  if (multikey) kinds.push('multikey')
  if (spec.expireAfterSeconds !== undefined) kinds.push('ttl')
  if (spec.partialFilterExpression) kinds.push('partial')
  if (spec.unique) kinds.push('unique')
  if (spec.sparse) kinds.push('sparse')
  if (spec.hidden) kinds.push('hidden')
  if (spec.collation) kinds.push('collation')
  return kinds
}

/** Whether the planner can tell us if this index is multikey (via a hinted explain). */
export function canProbeMultikey(spec: Doc): boolean {
  if (spec.hidden || spec.clustered) return false
  const values = Object.values((spec.key ?? {}) as Doc)
  const keys = Object.keys((spec.key ?? {}) as Doc)
  return values.every((v) => numeric(v) !== null) && !keys.some((k) => k.includes('$**'))
}

export const createIndexSchema = z.object({
  /** Key pattern, shell syntax: { field: 1, other: -1 } */
  keys: z.string().min(1).max(10_000),
  name: z.string().max(400),
  unique: z.boolean(),
  sparse: z.boolean(),
  hidden: z.boolean(),
  /** TTL in seconds (text so the form can be empty). */
  ttlSeconds: z.string().max(20),
  partialFilter: z.string().max(100_000),
  collation: z.string().max(10_000),
  wildcardProjection: z.string().max(10_000)
})
export type CreateIndexForm = z.infer<typeof createIndexSchema>

export const emptyCreateIndexForm: CreateIndexForm = {
  keys: '',
  name: '',
  unique: false,
  sparse: false,
  hidden: false,
  ttlSeconds: '',
  partialFilter: '',
  collation: '',
  wildcardProjection: ''
}

/**
 * Indexes of a collection: list (with size, usage and multikey), create, drop, hide/unhide, and
 * in-progress builds from $currentOp. Size, usage, multikey and builds are best effort: each
 * needs privileges a user may lack, so failures leave those values null.
 */
import type { CreateIndexesOptions, Document, MongoClient } from 'mongodb'
import { BSON } from 'bson'
import {
  canProbeMultikey,
  classifyIndex,
  keyValueText,
  type CreateIndexForm,
  type IndexBuild,
  type IndexInfo
} from '@shared/indexes'
import { toShellString } from '@shared/shell-format'
import type { ConnectionManager } from './connection-manager'
import { PRESERVE_TYPES } from './bson-options'
import { ReadableError } from './errors'
import { parseQueryField, parseShellValue } from './query-parser'
import { splitNamespace } from './query-service'

const KEY_VALUES = new Set(['text', '2dsphere', '2d', 'hashed', '2dsphere_bucket'])
const num = (v: unknown) => (v === undefined || v === null ? null : Number(String(v)))

/** Finds `isMultiKey` on the index scan in a queryPlanner explain. */
function multikeyIn(plan: unknown): boolean | null {
  if (!plan || typeof plan !== 'object') return null
  const p = plan as Document
  if (typeof p.isMultiKey === 'boolean' && /IXSCAN/.test(String(p.stage ?? ''))) return p.isMultiKey
  for (const v of Object.values(p)) {
    const r = multikeyIn(v)
    if (r !== null) return r
  }
  return null
}

/** Builds createIndex keys + options from the form. Throws a readable message. */
export function indexSpecFromForm(form: CreateIndexForm): { keys: Document; options: CreateIndexesOptions } {
  const k = parseShellValue(form.keys)
  if (!k.ok) throw new Error(`Keys: ${k.error.message}`)
  const keys = k.value as Document
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.keys(keys).length)
    throw new Error('Keys must be an object with at least one field, like { field: 1 }')
  for (const [f, v] of Object.entries(keys)) {
    const n = Number(String(v))
    const ok = typeof v === 'string' ? KEY_VALUES.has(v) : n === 1 || n === -1
    if (!ok) throw new Error(`Keys: "${f}" must be 1, -1, "text", "2dsphere", "2d" or "hashed"`)
  }
  const options: CreateIndexesOptions = {}
  if (form.name.trim()) options.name = form.name.trim()
  if (form.unique) options.unique = true
  if (form.sparse) options.sparse = true
  if (form.hidden) options.hidden = true
  if (form.ttlSeconds.trim()) {
    if (!/^\d+$/.test(form.ttlSeconds.trim())) throw new Error('TTL must be a whole number of seconds')
    options.expireAfterSeconds = Number(form.ttlSeconds.trim())
  }
  if (form.partialFilter.trim()) {
    const p = parseQueryField('filter', form.partialFilter)
    if (!p.ok) throw new Error(`Partial filter: ${p.error.message}`)
    options.partialFilterExpression = p.value as Document
  }
  if (form.collation.trim()) {
    const c = parseQueryField('collation', form.collation)
    if (!c.ok) throw new Error(`Collation: ${c.error.message}`)
    options.collation = c.value as CreateIndexesOptions['collation']
  }
  if (form.wildcardProjection.trim()) {
    const w = parseQueryField('project', form.wildcardProjection)
    if (!w.ok) throw new Error(`Wildcard projection: ${w.error.message}`)
    options.wildcardProjection = w.value as Document
  }
  return { keys, options }
}

export class IndexService {
  constructor(private readonly connections: ConnectionManager) {}

  private coll(connectionId: string, ns: string) {
    const { db, coll } = splitNamespace(ns)
    const client = this.connections.client(connectionId)
    return { client, db, name: coll, collection: client.db(db).collection(coll) }
  }

  async list(connectionId: string, ns: string): Promise<IndexInfo[]> {
    const { collection } = this.coll(connectionId, ns)
    let specs: Document[]
    try {
      specs = await collection.listIndexes(PRESERVE_TYPES).toArray()
    } catch (err) {
      throw new ReadableError(err)
    }
    const [sizes, usage, multikey] = await Promise.all([
      collection
        .aggregate([{ $collStats: { storageStats: {} } }])
        .toArray()
        .then((rows) => {
          const out: Record<string, number> = {}
          for (const r of rows)
            for (const [k, v] of Object.entries((r.storageStats?.indexSizes ?? {}) as Document))
              out[k] = (out[k] ?? 0) + Number(v)
          return out
        })
        .catch(() => null),
      collection
        .aggregate([{ $indexStats: {} }])
        .toArray()
        .then((rows) => {
          const out: Record<string, { ops: number; since: number }> = {}
          for (const r of rows) {
            const prev = out[r.name as string]
            const ops = Number(String(r.accesses?.ops ?? 0))
            const since = new Date(r.accesses?.since ?? 0).getTime()
            out[r.name as string] = prev
              ? { ops: prev.ops + ops, since: Math.min(prev.since, since) }
              : { ops, since }
          }
          return out
        })
        .catch(() => null),
      Promise.all(
        specs.map(async (s) => {
          if (!canProbeMultikey(s)) return null
          try {
            const filter = (s.partialFilterExpression as Document | undefined) ?? {}
            const plan = await collection
              .find(filter)
              .hint(s.name as string)
              .limit(1)
              .explain('queryPlanner')
            return multikeyIn(plan.queryPlanner)
          } catch {
            return null
          }
        })
      )
    ])
    return specs.map((s, i): IndexInfo => {
      const key = (s.key ?? {}) as Document
      const mk = multikey[i] ?? null
      const show = (v: unknown) => (v === undefined || v === null ? null : toShellString(v, 0))
      return {
        name: s.name as string,
        fields: Object.entries(key).map(([field, v]) => ({ field, value: keyValueText(v) })),
        keyText: `{ ${Object.entries(key)
          .map(
            ([f, v]) =>
              `${/^[A-Za-z_$][\w$]*$/.test(f) ? f : JSON.stringify(f)}: ${typeof v === 'string' ? JSON.stringify(v) : keyValueText(v)}`
          )
          .join(', ')} }`,
        kinds: classifyIndex(s, mk),
        multikey: mk,
        size: sizes?.[s.name as string] ?? null,
        usage: usage?.[s.name as string] ?? null,
        ttlSeconds: num(s.expireAfterSeconds),
        partialFilterText: show(s.partialFilterExpression),
        collationText: show(s.collation),
        wildcardProjectionText: show(s.wildcardProjection),
        weightsText: show(s.weights),
        specText: toShellString(BSON.deserialize(BSON.serialize(s), { promoteValues: false }), 2)
      }
    })
  }

  /** Index builds in progress on the collection (from $currentOp). */
  async builds(connectionId: string, ns: string): Promise<IndexBuild[]> {
    const { client, db, name } = this.coll(connectionId, ns)
    return currentBuilds(client, db, name).catch(() => [])
  }

  async create(connectionId: string, ns: string, form: CreateIndexForm): Promise<string> {
    const { keys, options } = indexSpecFromForm(form)
    const { collection } = this.coll(connectionId, ns)
    try {
      return await collection.createIndex(keys, options)
    } catch (err) {
      throw new ReadableError(err)
    }
  }

  async drop(connectionId: string, ns: string, name: string): Promise<void> {
    if (name === '_id_') throw new Error('The _id index can’t be dropped')
    const { collection } = this.coll(connectionId, ns)
    try {
      await collection.dropIndex(name)
    } catch (err) {
      throw new ReadableError(err)
    }
  }

  async setHidden(connectionId: string, ns: string, name: string, hidden: boolean): Promise<void> {
    if (name === '_id_') throw new Error('The _id index can’t be hidden')
    const { client, db, name: coll } = this.coll(connectionId, ns)
    try {
      await client.db(db).command({ collMod: coll, index: { name, hidden } })
    } catch (err) {
      throw new ReadableError(err)
    }
  }
}

async function currentBuilds(client: MongoClient, db: string, coll: string): Promise<IndexBuild[]> {
  const ops = await client
    .db('admin')
    .aggregate([
      { $currentOp: { allUsers: true, idleConnections: false } },
      {
        $match: {
          'command.createIndexes': coll,
          $or: [{ 'command.$db': db }, { ns: { $regex: `^${db.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.` } }]
        }
      }
    ])
    .toArray()
  // A build shows up as the client's createIndexes command and the builder thread; prefer the
  // one reporting progress.
  const byIndexes = new Map<string, IndexBuild>()
  for (const op of ops) {
    const indexes = ((op.command?.indexes ?? []) as Document[]).map((i) => String(i.name))
    const k = indexes.join(',')
    const progress = op.progress as { done?: unknown; total?: unknown } | undefined
    const build: IndexBuild = {
      indexes,
      message: String(op.msg ?? 'Building'),
      done: progress ? Number(String(progress.done)) : null,
      total: progress ? Number(String(progress.total)) : null
    }
    const prev = byIndexes.get(k)
    if (!prev || (prev.total === null && build.total !== null)) byIndexes.set(k, build)
  }
  return [...byIndexes.values()]
}

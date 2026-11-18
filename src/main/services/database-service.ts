/**
 * Databases and collections: list (with counts), create, drop.
 * Permission checks are applied by the IPC layer (Phase 4) before these run.
 */
import type { CreateCollectionOptions } from 'mongodb'
import type { CollectionInfo, CollectionType, DatabaseInfo } from '@shared/connection'
import { validateCollectionName, validateDatabaseName } from '@shared/connection'
import type { ConnectionManager } from './connection-manager'
import { ReadableError } from './errors'

const COUNT_CONCURRENCY = 8
const COUNT_MAX_TIME_MS = 3000
/** Server bookkeeping that users never query directly. */
const HIDDEN_COLLECTION = /^system\.(views|buckets\..*)$/

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export interface CreateCollectionInput {
  capped?: { size: number; max?: number }
  timeseries?: { timeField: string; metaField?: string; granularity?: 'seconds' | 'minutes' | 'hours' }
  clusteredIndex?: boolean
}

export class DatabaseService {
  constructor(private readonly connections: ConnectionManager) {}

  async listDatabases(connId: string): Promise<DatabaseInfo[]> {
    const client = this.connections.client(connId)
    try {
      const res = await client.db('admin').admin().listDatabases({ authorizedDatabases: true })
      return res.databases
        .map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk ?? null, empty: d.empty ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (err) {
      // Users without listDatabases (e.g. read on one db) can still use the db from the URI.
      const fallback = client.options.dbName
      if (fallback && fallback !== 'test') return [{ name: fallback, sizeOnDisk: null, empty: null }]
      throw new ReadableError(err)
    }
  }

  async listCollections(connId: string, dbName: string): Promise<CollectionInfo[]> {
    const db = this.connections.client(connId).db(dbName)
    let raw
    try {
      raw = await db.listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray()
    } catch (err) {
      throw new ReadableError(err)
    }
    const items = raw
      .filter((c) => !HIDDEN_COLLECTION.test(c.name))
      .map((c) => {
        const options = (c as { options?: Record<string, unknown> }).options ?? {}
        return {
          name: c.name,
          type: ((c as { type?: string }).type ?? 'collection') as CollectionType,
          capped: options['capped'] === true,
          viewOn: (options['viewOn'] as string | undefined) ?? null
        }
      })
    const counts = await mapLimit(items, COUNT_CONCURRENCY, async (c) => {
      if (c.type === 'view') return null
      try {
        return await db.collection(c.name).estimatedDocumentCount({ maxTimeMS: COUNT_MAX_TIME_MS })
      } catch {
        return null
      }
    })
    return items
      .map((c, i) => ({ ...c, count: counts[i] ?? null }))
      .sort(
        (a, b) =>
          Number(a.name.startsWith('system.')) - Number(b.name.startsWith('system.')) ||
          a.name.localeCompare(b.name)
      )
  }

  async createCollection(
    connId: string,
    dbName: string,
    name: string,
    opts: CreateCollectionInput = {}
  ): Promise<void> {
    const dbErr = validateDatabaseName(dbName)
    if (dbErr) throw new Error(dbErr)
    const collErr = validateCollectionName(name)
    if (collErr) throw new Error(collErr)
    const options: CreateCollectionOptions = {}
    if (opts.capped) {
      options.capped = true
      options.size = opts.capped.size
      if (opts.capped.max) options.max = opts.capped.max
    }
    if (opts.timeseries) options.timeseries = opts.timeseries
    if (opts.clusteredIndex) options.clusteredIndex = { key: { _id: 1 }, unique: true }
    try {
      await this.connections.client(connId).db(dbName).createCollection(name, options)
    } catch (err) {
      throw new ReadableError(err)
    }
  }

  /** MongoDB creates a database with its first collection. */
  async createDatabase(
    connId: string,
    dbName: string,
    firstCollection: string,
    opts?: CreateCollectionInput
  ) {
    return this.createCollection(connId, dbName, firstCollection, opts)
  }

  async dropCollection(connId: string, dbName: string, name: string): Promise<void> {
    try {
      await this.connections.client(connId).db(dbName).collection(name).drop()
    } catch (err) {
      throw new ReadableError(err)
    }
  }

  async dropDatabase(connId: string, dbName: string): Promise<void> {
    try {
      await this.connections.client(connId).db(dbName).dropDatabase()
    } catch (err) {
      throw new ReadableError(err)
    }
  }
}

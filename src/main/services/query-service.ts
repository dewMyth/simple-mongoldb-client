/**
 * Runs find() and counts for the query bar. Results leave this module as canonical EJSON.
 */
import type { Document, FindCursor, FindOptions, Sort } from 'mongodb'
import { ownBytes, type BsonBytes } from '@shared/bson-wire'
import {
  pageWindow,
  type CountResult,
  type FindPage,
  type FindResult,
  type PageRequest,
  type QueryText
} from '@shared/query'
import type { ConnectionManager } from './connection-manager'
import { CancelledError, type CursorRegistry } from './cursor-registry'
import { ReadableError } from './errors'
import { parseQuery, type ParsedQuery } from './query-parser'

export const DEFAULT_BATCH_SIZE = 100
const COUNT_MAX_TIME_MS = 5000
const LOWER_BOUND_LIMIT = 10_000

export function splitNamespace(ns: string): { db: string; coll: string } {
  const dot = ns.indexOf('.')
  if (dot <= 0 || dot === ns.length - 1) throw new Error(`Invalid namespace: ${ns}`)
  return { db: ns.slice(0, dot), coll: ns.slice(dot + 1) }
}

function findOptions(q: ParsedQuery, batchSize: number): FindOptions {
  // raw: the driver hands back each document's BSON bytes untouched (no decode/re-encode),
  // which is also what crosses IPC. Types can't be promoted because nothing is decoded here.
  const o: FindOptions = { batchSize, raw: true }
  if (q.project) o.projection = q.project
  if (q.sort) o.sort = q.sort as Sort
  if (q.collation) o.collation = q.collation as FindOptions['collation']
  if (q.hint) o.hint = q.hint
  if (q.skip) o.skip = q.skip
  if (q.limit) o.limit = q.limit
  if (q.maxTimeMS) o.maxTimeMS = q.maxTimeMS
  return o
}

async function readBatch(cursor: FindCursor, max: number): Promise<FindPage> {
  const docs: BsonBytes[] = []
  while (docs.length < max) {
    // Take what's already buffered first so we only hit the server when needed.
    const buffered = cursor.readBufferedDocuments(max - docs.length)
    for (const d of buffered) docs.push(ownBytes(d as unknown as Uint8Array))
    if (docs.length >= max) break
    if (!(await cursor.hasNext())) return { docs, exhausted: true }
  }
  // Peek cheaply: if the cursor is closed and nothing is buffered, we're done.
  const exhausted = cursor.closed && cursor.bufferedCount() === 0
  return { docs, exhausted }
}

export class QueryService {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly registry: CursorRegistry,
    /** maxTimeMS for finds that don't set one (a setting; 0 = none). */
    private readonly defaultMaxTimeMS: () => number = () => 0
  ) {}

  async find(input: {
    connectionId: string
    ns: string
    tabId?: string | null
    query: QueryText
    batchSize?: number
    page?: PageRequest
  }): Promise<FindResult> {
    const t0 = performance.now()
    const parsed = parseQuery(input.query)
    if (!parsed.ok) return { ok: false, errors: parsed.errors }
    const parseMs = performance.now() - t0
    if (parsed.query.maxTimeMS === undefined && this.defaultMaxTimeMS() > 0)
      parsed.query.maxTimeMS = this.defaultMaxTimeMS()

    let batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE
    if (input.page) {
      const win = pageWindow(parsed.query, input.page)
      if (!win) return { ok: true, cursorId: '', parseMs, firstBatchMs: 0, docs: [], exhausted: true }
      parsed.query.skip = win.skip
      parsed.query.limit = win.limit
      // The whole page comes back in the first batch, so the server closes the cursor itself.
      batchSize = win.limit
    }

    const client = this.connections.client(input.connectionId)
    const { db, coll } = splitNamespace(input.ns)
    const op = this.registry.register({
      client,
      connectionId: input.connectionId,
      tabId: input.tabId,
      kind: 'cursor'
    })
    const cursor = client
      .db(db)
      .collection(coll)
      .find(parsed.query.filter, {
        ...findOptions(parsed.query, batchSize),
        comment: op.comment,
        signal: op.controller.signal
      })
    op.cursor = cursor

    try {
      const page = await readBatch(cursor, batchSize)
      if (page.exhausted) {
        this.registry.release(op.id)
        await cursor.close().catch(() => {})
      }
      return { ok: true, cursorId: op.id, parseMs, firstBatchMs: performance.now() - t0, ...page }
    } catch (err) {
      this.registry.release(op.id)
      await cursor.close().catch(() => {})
      if (op.controller.signal.aborted) throw new CancelledError()
      throw new ReadableError(err)
    }
  }

  async getMore(cursorId: string, count: number): Promise<FindPage> {
    const op = this.registry.get(cursorId)
    if (!op?.cursor) return { docs: [], exhausted: true }
    try {
      const page = await readBatch(op.cursor as FindCursor, count)
      if (page.exhausted) {
        this.registry.release(cursorId)
        await op.cursor.close().catch(() => {})
      }
      return page
    } catch (err) {
      this.registry.release(cursorId)
      await op.cursor.close().catch(() => {})
      if (op.controller.signal.aborted) throw new CancelledError()
      throw new ReadableError(err)
    }
  }

  /**
   * No filter → estimatedDocumentCount (instant, from metadata).
   * Filter → countDocuments with maxTimeMS 5000; on timeout, a bounded count gives "≥ N".
   */
  async count(input: {
    connectionId: string
    ns: string
    tabId?: string | null
    query: QueryText
    opId?: string
  }): Promise<CountResult> {
    const parsed = parseQuery(input.query)
    if (!parsed.ok) throw new Error(parsed.errors[0]!.message)
    const client = this.connections.client(input.connectionId)
    const { db, coll } = splitNamespace(input.ns)
    const collection = client.db(db).collection(coll)
    const q = parsed.query
    const hasFilter = Object.keys(q.filter).length > 0
    const op = this.registry.register({
      client,
      connectionId: input.connectionId,
      tabId: input.tabId,
      kind: 'command'
    })
    const base = { comment: op.comment, signal: op.controller.signal }
    const opts: Document = { ...base }
    if (q.collation) opts['collation'] = q.collation
    if (q.hint) opts['hint'] = q.hint

    try {
      if (!hasFilter) {
        try {
          const value = await collection.estimatedDocumentCount({ ...base, maxTimeMS: COUNT_MAX_TIME_MS })
          return { value, exact: true, method: 'estimated' }
        } catch (err) {
          // Views don't support estimatedDocumentCount; fall through to countDocuments.
          if (op.controller.signal.aborted) throw err
        }
      }
      try {
        const value = await collection.countDocuments(q.filter, { ...opts, maxTimeMS: COUNT_MAX_TIME_MS })
        return { value, exact: true, method: 'countDocuments' }
      } catch (err) {
        if ((err as { code?: number }).code !== 50) throw err
        // Timed out: get a cheap lower bound instead of blocking the UI.
        try {
          const value = await collection.countDocuments(q.filter, {
            ...opts,
            limit: LOWER_BOUND_LIMIT,
            maxTimeMS: 2000
          })
          return {
            value,
            exact: value < LOWER_BOUND_LIMIT,
            method: value < LOWER_BOUND_LIMIT ? 'countDocuments' : 'lowerBound'
          }
        } catch {
          return { value: 0, exact: false, method: 'lowerBound' }
        }
      }
    } catch (err) {
      if (op.controller.signal.aborted) throw new CancelledError()
      throw new ReadableError(err)
    } finally {
      this.registry.release(op.id)
    }
  }
}

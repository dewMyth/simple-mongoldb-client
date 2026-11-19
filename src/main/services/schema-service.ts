/**
 * Samples a collection and summarises its fields (paths, types, frequency).
 * Used for table columns, autocomplete (1,000-doc sample with values) and the Schema tab.
 */
import { parseSchema } from '@mongodb-js/mongodb-schema'
import type { Document } from 'mongodb'
import type { SchemaResult } from '@shared/schema'
import { toSchemaFields } from './schema-analysis'
import { parseQueryField } from './query-parser'
import { CancelledError } from './cursor-registry'
import { collectFieldStats, type FieldStat } from '@shared/field-stats'
import type { ConnectionManager } from './connection-manager'
import type { CursorRegistry } from './cursor-registry'
import { PRESERVE_TYPES } from './bson-options'
import { ReadableError } from './errors'
import { splitNamespace } from './query-service'

export interface FieldSample {
  sampled: number
  fields: FieldStat[]
}

export class SchemaService {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly registry: CursorRegistry
  ) {}

  async sampleFields(input: {
    connectionId: string
    ns: string
    tabId?: string | null
    size?: number
    /** Collect distinct string values for fields with at most this many (value autocomplete). */
    maxValues?: number
  }): Promise<FieldSample> {
    const client = this.connections.client(input.connectionId)
    const { db, coll } = splitNamespace(input.ns)
    const op = this.registry.register({
      client,
      connectionId: input.connectionId,
      tabId: input.tabId,
      kind: 'command'
    })
    try {
      const docs = await client
        .db(db)
        .collection(coll)
        .aggregate([{ $sample: { size: input.size ?? 200 } }], {
          ...PRESERVE_TYPES,
          maxTimeMS: 5000,
          allowDiskUse: false,
          comment: op.comment,
          signal: op.controller.signal
        })
        .toArray()
      return { sampled: docs.length, fields: collectFieldStats(docs, { maxValues: input.maxValues }) }
    } catch (err) {
      throw new ReadableError(err)
    } finally {
      this.registry.release(op.id)
    }
  }

  /**
   * Schema tab: $sample (after an optional filter) analysed by mongodb-schema, with types,
   * presence and charts per field. BSON types are kept exact (Int32 vs Double vs Int64).
   */
  async analyze(input: {
    connectionId: string
    ns: string
    tabId?: string | null
    sampleSize: number
    filter: string
  }): Promise<SchemaResult> {
    const t0 = performance.now()
    const f = parseQueryField('filter', input.filter)
    if (!f.ok) throw new Error(`Filter: ${f.error.message}`)
    const filter = f.value as Document
    const client = this.connections.client(input.connectionId)
    const { db, coll } = splitNamespace(input.ns)
    const op = this.registry.register({
      client,
      connectionId: input.connectionId,
      tabId: input.tabId,
      kind: 'command'
    })
    try {
      const pipeline: Document[] = Object.keys(filter).length ? [{ $match: filter }] : []
      pipeline.push({ $sample: { size: input.sampleSize } })
      const docs = await client
        .db(db)
        .collection(coll)
        .aggregate(pipeline, {
          ...PRESERVE_TYPES,
          maxTimeMS: 60_000,
          allowDiskUse: true,
          comment: op.comment,
          signal: op.controller.signal
        })
        .toArray()
      const schema = await parseSchema(docs, {
        storeValues: true,
        semanticTypes: false,
        signal: op.controller.signal
      })
      return { sampled: docs.length, fields: toSchemaFields(schema), ms: Math.round(performance.now() - t0) }
    } catch (err) {
      if (op.controller.signal.aborted) throw new CancelledError()
      throw new ReadableError(err)
    } finally {
      this.registry.release(op.id)
    }
  }
}

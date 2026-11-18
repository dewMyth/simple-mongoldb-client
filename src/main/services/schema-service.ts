/**
 * Samples a collection and summarises its fields (paths, types, frequency).
 * Phase 5 uses it for table columns; Phase 7 for autocomplete; Phase 12 for the schema tab.
 */
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
      return { sampled: docs.length, fields: collectFieldStats(docs) }
    } catch (err) {
      throw new ReadableError(err)
    } finally {
      this.registry.release(op.id)
    }
  }
}

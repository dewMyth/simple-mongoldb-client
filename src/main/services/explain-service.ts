/**
 * Runs explain("executionStats") for a find or an aggregation and analyses it (shared/explain).
 * executionStats really runs the query, so it's cancellable like any other operation, and
 * pipelines ending in $out/$merge are explained without that last stage (never written).
 */
import type { CollationOptions, Document } from 'mongodb'
import { BSON } from 'bson'
import { ownBytes } from '@shared/bson-wire'
import { analyzeExplain, type ExplainResult, type ExplainSource } from '@shared/explain'
import { containsWriteStage, isWriteStage } from '@shared/pipeline'
import type { ConnectionManager } from './connection-manager'
import { CancelledError, type CursorRegistry } from './cursor-registry'
import { ReadableError } from './errors'
import { parseQuery } from './query-parser'
import { splitNamespace } from './query-service'
import { buildPipeline, parsePipelineOptions } from './aggregation-service'

/** Explain runs the query: stop runaway ones unless the user set maxTimeMS. */
const EXPLAIN_MAX_TIME_MS = 60_000

export class ExplainService {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly registry: CursorRegistry
  ) {}

  async explain(input: {
    connectionId: string
    ns: string
    tabId?: string | null
    source: ExplainSource
  }): Promise<ExplainResult> {
    const { db, coll } = splitNamespace(input.ns)
    const client = this.connections.client(input.connectionId)
    const collection = client.db(db).collection(coll)
    const notes: string[] = []
    const op = this.registry.register({
      client,
      connectionId: input.connectionId,
      tabId: input.tabId,
      kind: 'command'
    })
    try {
      let explain: Document
      let filter: Document | null = null
      let sort: Document | null = null
      const signal = op.controller.signal
      if (input.source.kind === 'find') {
        const parsed = parseQuery(input.source.query)
        if (!parsed.ok) throw new Error(`${parsed.errors[0]!.field}: ${parsed.errors[0]!.message}`)
        const q = parsed.query
        filter = q.filter
        sort = Array.isArray(q.sort) ? Object.fromEntries(q.sort) : (q.sort ?? null)
        explain = await collection
          .find(q.filter, {
            projection: q.project,
            sort: q.sort,
            skip: q.skip,
            limit: q.limit,
            collation: q.collation as CollationOptions | undefined,
            hint: q.hint,
            maxTimeMS: q.maxTimeMS ?? EXPLAIN_MAX_TIME_MS,
            comment: op.comment,
            signal
          })
          .explain('executionStats')
      } else {
        const built = buildPipeline(input.source.stages)
        if (!built.ok) throw new Error(`Stage ${built.errors[0]!.index + 1}: ${built.errors[0]!.message}`)
        const opts = parsePipelineOptions(input.source.options)
        if (!opts.ok) throw new Error(opts.message)
        let pipeline = built.pipeline
        const last = input.source.stages.at(-1)
        if (last && isWriteStage(last.operator)) {
          pipeline = pipeline.slice(0, -1)
          notes.push(`Explained without the final ${last.operator} stage, which would write.`)
        }
        if (containsWriteStage(pipeline))
          throw new Error('Pipelines with $out or $merge inside can’t be explained')
        const first = pipeline[0]
        if (first && '$match' in first) {
          filter = first.$match as Document
          const second = pipeline[1]
          if (second && '$sort' in second) sort = second.$sort as Document
        } else if (first && '$sort' in first) sort = first.$sort as Document
        explain = await collection
          .aggregate(pipeline, {
            allowDiskUse: opts.options.allowDiskUse,
            collation: opts.options.collation as CollationOptions | undefined,
            maxTimeMS: opts.options.maxTimeMS ?? EXPLAIN_MAX_TIME_MS,
            comment: op.comment,
            signal
          })
          .explain('executionStats')
      }
      const [docCount, indexKeys] = await Promise.all([
        collection.estimatedDocumentCount().catch(() => null),
        collection
          .listIndexes()
          .toArray()
          .then((ix) => ix.map((i) => i.key as Document))
          .catch(() => [] as Document[])
      ])
      const analysis = analyzeExplain(explain, { kind: input.source.kind, filter, sort, docCount, indexKeys })
      return { ...analysis, notes: [...notes, ...analysis.notes], raw: ownBytes(BSON.serialize(explain)) }
    } catch (err) {
      if (op.controller.signal.aborted) throw new CancelledError()
      if (err instanceof Error && !(err as { code?: unknown }).code && !(err as { errmsg?: unknown }).errmsg)
        throw err
      throw new ReadableError(err)
    } finally {
      this.registry.release(op.id)
    }
  }
}

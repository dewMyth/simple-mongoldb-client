/**
 * Aggregation builder backend: per-stage previews, full runs, views and code export.
 *
 * Safety: previews never run $out/$merge. Every stage is parsed here (never eval'd) and any
 * prefix containing a write stage, at any depth, is refused before reaching the server.
 */
import type { AggregateOptions, Document } from 'mongodb'
import { ownBytes } from '@shared/bson-wire'
import { exportAggregate, type ExportableAggregateOptions, type ExportLanguage } from '@shared/code-export'
import {
  containsWriteStage,
  OPERATOR_RE,
  type PipelineOptions,
  type PipelineRunResult,
  type StageInput,
  type StagePreview
} from '@shared/pipeline'
import type { ConnectionManager } from './connection-manager'
import type { CursorRegistry, TrackedOp } from './cursor-registry'
import { CancelledError } from './cursor-registry'
import { ReadableError } from './errors'
import { parseQueryField, parseShellValue } from './query-parser'
import { splitNamespace } from './query-service'

/** Previews stop after this long unless the user set maxTimeMS. */
const PREVIEW_MAX_TIME_MS = 10_000
/** Documents returned by "Run full pipeline". */
export const RUN_LIMIT = 100

export interface StageError {
  index: number
  message: string
  line?: number
  column?: number
}

export type BuiltPipeline = { ok: true; pipeline: Document[] } | { ok: false; errors: StageError[] }

/** Parses each stage body into `{ $op: value }`. Errors are per stage. */
export function buildPipeline(stages: StageInput[]): BuiltPipeline {
  const pipeline: Document[] = []
  const errors: StageError[] = []
  stages.forEach((s, index) => {
    if (!OPERATOR_RE.test(s.operator)) {
      errors.push({
        index,
        message: s.operator ? `"${s.operator}" isn't a stage operator` : 'Choose a stage'
      })
      return
    }
    if (!s.body.trim()) {
      errors.push({ index, message: `${s.operator} needs a value` })
      return
    }
    const r = parseShellValue(s.body)
    if (!r.ok) errors.push({ index, ...r.error })
    else pipeline.push({ [s.operator]: r.value })
  })
  return errors.length ? { ok: false, errors } : { ok: true, pipeline }
}

export type ParsedOptions = { ok: true; options: ExportableAggregateOptions } | { ok: false; message: string }

export function parsePipelineOptions(o: PipelineOptions): ParsedOptions {
  const out: ExportableAggregateOptions = {}
  if (o.allowDiskUse) out.allowDiskUse = true
  if (o.maxTimeMS.trim()) {
    if (!/^\d+$/.test(o.maxTimeMS.trim()))
      return { ok: false, message: 'maxTimeMS must be a whole number of milliseconds' }
    out.maxTimeMS = Number(o.maxTimeMS.trim())
  }
  if (o.collation.trim()) {
    const c = parseQueryField('collation', o.collation)
    if (!c.ok) return { ok: false, message: `Collation: ${c.error.message}` }
    out.collation = c.value as Record<string, unknown>
  }
  if (o.comment.trim()) out.comment = o.comment.trim()
  return { ok: true, options: out }
}

/** The namespace a $out / $merge stage writes to. */
export function writeTarget(stage: Document, sourceDb: string): string | null {
  const out = stage.$out as unknown
  const merge = stage.$merge as unknown
  const spec =
    out ?? (merge && typeof merge === 'object' && 'into' in merge ? (merge as { into: unknown }).into : merge)
  if (spec === undefined) return null
  if (typeof spec === 'string') return `${sourceDb}.${spec}`
  const s = spec as { db?: string; coll?: string }
  return s.coll ? `${s.db ?? sourceDb}.${s.coll}` : null
}

export class AggregationService {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly registry: CursorRegistry
  ) {}

  private register(connectionId: string, tabId: string | null | undefined, userComment?: string): TrackedOp {
    const op = this.registry.register({
      client: this.connections.client(connectionId),
      connectionId,
      tabId,
      kind: 'command'
    })
    // Our comment tags the op for cancellation; keep the user's comment visible too.
    if (userComment) op.comment = `${userComment} [${op.comment}]`
    return op
  }

  private async aggregate(
    input: { connectionId: string; ns: string; tabId?: string | null },
    pipeline: Document[],
    options: ExportableAggregateOptions,
    maxTimeMS: number | undefined
  ): Promise<{ docs: Uint8Array<ArrayBuffer>[]; ms: number }> {
    const { db, coll } = splitNamespace(input.ns)
    const op = this.register(input.connectionId, input.tabId, options.comment)
    const t0 = performance.now()
    try {
      const aggOptions: AggregateOptions & { signal?: AbortSignal } = {
        raw: true,
        allowDiskUse: options.allowDiskUse,
        collation: options.collation as AggregateOptions['collation'],
        maxTimeMS,
        comment: op.comment,
        signal: op.controller.signal
      }
      const cursor = op.client.db(db).collection(coll).aggregate(pipeline, aggOptions)
      op.cursor = cursor
      const raw = (await cursor.toArray()) as unknown as Uint8Array[]
      return { docs: raw.map((d) => ownBytes(d)), ms: Math.round(performance.now() - t0) }
    } catch (err) {
      if (op.controller.signal.aborted) throw new CancelledError()
      throw new ReadableError(err)
    } finally {
      this.registry.release(op.id)
    }
  }

  /**
   * One preview per stage: the pipeline up to that stage, then $limit. Write stages and
   * everything after them are skipped; a stage with a syntax error blocks the ones after it.
   */
  async preview(input: {
    connectionId: string
    ns: string
    tabId?: string | null
    stages: StageInput[]
    sampleSize: number
    options: PipelineOptions
    /** Only run the final stage's preview (text mode shows just the pipeline's output). */
    lastOnly?: boolean
  }): Promise<StagePreview[]> {
    const opts = parsePipelineOptions(input.options)
    const parsed: (Document | StagePreview)[] = input.stages.map((s) => {
      const b = buildPipeline([s])
      if (!b.ok) {
        const e = b.errors[0]!
        return { status: 'error', message: e.message, own: true, line: e.line, column: e.column }
      }
      return b.pipeline[0]!
    })
    const isPreview = (x: Document | StagePreview): x is StagePreview =>
      'status' in x && (x.status === 'error' || x.status === 'ok' || x.status === 'skipped')

    const results: Promise<StagePreview>[] = []
    let blocked: StagePreview | null = null
    const prefix: Document[] = []
    for (const p of parsed) {
      if (blocked) {
        results.push(Promise.resolve(blocked))
        continue
      }
      if (isPreview(p)) {
        results.push(Promise.resolve(p))
        blocked = { status: 'skipped', reason: 'blocked' }
        continue
      }
      if (containsWriteStage(p)) {
        blocked = { status: 'skipped', reason: 'write' }
        results.push(Promise.resolve(blocked))
        continue
      }
      prefix.push(p)
      if (input.lastOnly && results.length < parsed.length - 1) {
        results.push(Promise.resolve({ status: 'skipped', reason: 'blocked' }))
        continue
      }
      if (!opts.ok) {
        results.push(Promise.resolve({ status: 'error', message: opts.message, own: false }))
        continue
      }
      const pipeline = [...prefix, { $limit: input.sampleSize }]
      // Defence in depth: the pipeline we send can never contain a write stage.
      if (containsWriteStage(pipeline)) throw new Error('Refusing to preview a pipeline that writes')
      results.push(
        this.aggregate(input, pipeline, opts.options, opts.options.maxTimeMS ?? PREVIEW_MAX_TIME_MS).then(
          (r): StagePreview => ({ status: 'ok', docs: r.docs, ms: r.ms }),
          (err: Error): StagePreview => {
            if (err instanceof CancelledError) throw err
            return { status: 'error', message: err.message, own: false }
          }
        )
      )
    }
    return Promise.all(results)
  }

  /** Runs the whole pipeline. Returns up to RUN_LIMIT documents, or where it wrote. */
  async run(input: {
    connectionId: string
    ns: string
    tabId?: string | null
    stages: StageInput[]
    options: PipelineOptions
  }): Promise<PipelineRunResult> {
    const built = buildPipeline(input.stages)
    if (!built.ok) throw new Error(`Stage ${built.errors[0]!.index + 1}: ${built.errors[0]!.message}`)
    const opts = parsePipelineOptions(input.options)
    if (!opts.ok) throw new Error(opts.message)
    const last = built.pipeline.at(-1)
    const target = last ? writeTarget(last, splitNamespace(input.ns).db) : null
    if (target) {
      const r = await this.aggregate(input, built.pipeline, opts.options, opts.options.maxTimeMS)
      return { kind: 'written', target, ms: r.ms }
    }
    if (containsWriteStage(built.pipeline)) throw new Error('$out and $merge must be the last stage')
    const r = await this.aggregate(
      input,
      [...built.pipeline, { $limit: RUN_LIMIT + 1 }],
      opts.options,
      opts.options.maxTimeMS
    )
    return { kind: 'docs', docs: r.docs.slice(0, RUN_LIMIT), more: r.docs.length > RUN_LIMIT, ms: r.ms }
  }

  async createView(input: {
    connectionId: string
    ns: string
    name: string
    stages: StageInput[]
  }): Promise<string> {
    const built = buildPipeline(input.stages)
    if (!built.ok) throw new Error(`Stage ${built.errors[0]!.index + 1}: ${built.errors[0]!.message}`)
    if (containsWriteStage(built.pipeline)) throw new Error('A view can’t contain $out or $merge')
    const { db, coll } = splitNamespace(input.ns)
    try {
      await this.connections.client(input.connectionId).db(db).createCollection(input.name, {
        viewOn: coll,
        pipeline: built.pipeline
      })
    } catch (err) {
      throw new ReadableError(err)
    }
    return `${db}.${input.name}`
  }

  exportCode(input: {
    ns: string
    stages: StageInput[]
    options: PipelineOptions
    language: ExportLanguage
  }): { ok: true; code: string } | { ok: false; message: string } {
    const built = buildPipeline(input.stages)
    if (!built.ok)
      return { ok: false, message: `Stage ${built.errors[0]!.index + 1}: ${built.errors[0]!.message}` }
    const opts = parsePipelineOptions(input.options)
    if (!opts.ok) return { ok: false, message: opts.message }
    const { db, coll } = splitNamespace(input.ns)
    return {
      ok: true,
      code: exportAggregate(input.language, { db, collection: coll }, built.pipeline, opts.options)
    }
  }
}

/**
 * Explain plan analysis (pure): turns explain("executionStats") output into a summary, a stage
 * tree, hints, and an index suggestion.
 *
 * Shapes handled (checked against MongoDB 8.2):
 *  - find, classic engine: executionStats.executionStages has per-stage counts.
 *  - aggregate: `stages: [{ $cursor: { queryPlanner, executionStats } }, { $sort… }, …]`, or the
 *    whole pipeline pushed down (top-level queryPlanner/executionStats).
 *  - SBE (explainVersion "2"): executionStages are SBE internals, so the tree comes from
 *    queryPlanner.winningPlan.queryPlan (classic stage names, no per-stage counts).
 *  - sharded: the first shard's plan is shown (noted).
 */
import { z } from 'zod'
import type { BsonBytes } from './bson-wire'
import { queryTextSchema } from './query'
import { pipelineOptionsSchema, stageInputSchema } from './pipeline'

export const explainSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('find'), query: queryTextSchema }),
  z.object({
    kind: z.literal('aggregate'),
    stages: z.array(stageInputSchema).max(500),
    options: pipelineOptionsSchema
  })
])
export type ExplainSource = z.infer<typeof explainSourceSchema>

export interface PlanNode {
  stage: string
  /** Short facts: index name and bounds, filter, sort pattern… */
  details: string[]
  nReturned: number | null
  docsExamined: number | null
  keysExamined: number | null
  ms: number | null
  kind: 'collscan' | 'ixscan' | 'sort' | 'stage' | 'other'
  children: PlanNode[]
}

export interface ExplainSummary {
  executionTimeMs: number | null
  nReturned: number | null
  docsExamined: number | null
  keysExamined: number | null
  indexes: string[]
  collscan: boolean
  inMemorySort: boolean
  engine: 'classic' | 'sbe'
  /** Estimated documents in the collection. */
  docCount: number | null
}

export interface ExplainHint {
  kind: 'collscan' | 'sort' | 'ratio' | 'unused-index'
  message: string
}

export interface IndexSuggestion {
  fields: { field: string; direction: 1 | -1 }[]
  /** Shell syntax, e.g. { status: 1, total: -1 }. */
  keyText: string
  /** The server's default name for it, e.g. status_1_total_-1. */
  name: string
  /** An index with exactly these keys already exists. */
  exists: boolean
}

export interface ExplainResult {
  summary: ExplainSummary
  tree: PlanNode
  hints: ExplainHint[]
  suggestion: IndexSuggestion | null
  notes: string[]
  /** The full explain output (BSON). */
  raw: BsonBytes
}

type Doc = Record<string, unknown>
const isObj = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && 'valueOf' in v) {
    const n = Number((v as { valueOf(): unknown }).valueOf())
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Collection scans warn above this many documents. */
export const LARGE_COLLECTION = 1000
/** "Examined N× more documents than returned" warns above this ratio. */
export const RATIO_LIMIT = 10

const brief = (v: unknown, max = 120) => {
  const s = JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x))
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function nodeKind(stage: string): PlanNode['kind'] {
  if (stage === 'COLLSCAN') return 'collscan'
  if (/IXSCAN|IDHACK|COUNT_SCAN|DISTINCT_SCAN/.test(stage)) return 'ixscan'
  if (stage === 'SORT' || stage === '$sort') return 'sort'
  return 'other'
}

/** A classic plan stage (from executionStages or queryPlan) → PlanNode. */
function toNode(n: Doc): PlanNode {
  const stage = String(n.stage ?? '?')
  const details: string[] = []
  // EQ_LOOKUP's index belongs to the foreign collection; it's described with the lookup below.
  if (n.indexName && stage !== 'EQ_LOOKUP')
    details.push(`index ${String(n.indexName)}${n.keyPattern ? ` ${brief(n.keyPattern)}` : ''}`)
  if (n.isMultiKey) details.push('multikey')
  if (n.indexBounds) details.push(`bounds ${brief(n.indexBounds)}`)
  if (n.filter) details.push(`filter ${brief(n.filter)}`)
  if (n.sortPattern) details.push(`sort ${brief(n.sortPattern)}${n.usedDisk ? ' (spilled to disk)' : ''}`)
  if (n.limitAmount !== undefined) details.push(`limit ${String(n.limitAmount)}`)
  if (n.skipAmount !== undefined) details.push(`skip ${String(n.skipAmount)}`)
  if (n.transformBy) details.push(`projection ${brief(n.transformBy)}`)
  if (stage === 'EQ_LOOKUP')
    details.push(
      `from ${String(n.foreignCollection ?? '?')} (${String(n.strategy ?? '')}${n.indexName ? ` via ${String(n.indexName)}` : ''})`
    )
  const children = [
    ...(isObj(n.inputStage) ? [n.inputStage] : []),
    ...(Array.isArray(n.inputStages) ? (n.inputStages as unknown[]).filter(isObj) : [])
  ].map(toNode)
  return {
    stage,
    details,
    nReturned: num(n.nReturned),
    docsExamined: num(n.docsExamined),
    keysExamined: num(n.keysExamined),
    ms: num(n.executionTimeMillisEstimate),
    kind: nodeKind(stage),
    children
  }
}

function walk(node: PlanNode, fn: (n: PlanNode) => void) {
  fn(node)
  for (const c of node.children) walk(c, fn)
}

interface Source {
  queryPlanner: Doc
  executionStats: Doc | null
  sbe: boolean
}

/** The part of the explain that holds the query plan (find, $cursor, pushed-down, sharded). */
function planSource(explain: Doc, notes: string[]): Source | null {
  const version = String(explain.explainVersion ?? '1')
  const from = (qp: Doc, es: Doc | null): Source => {
    let queryPlanner = qp
    let executionStats = es
    const wp = qp.winningPlan
    if (isObj(wp) && Array.isArray(wp.shards) && wp.shards.length) {
      // Sharded: show the first shard (each shard can pick a different plan).
      const shard = wp.shards[0] as Doc
      notes.push(
        `Sharded collection: showing the plan of shard ${String(shard.shardName ?? '1')} of ${wp.shards.length}.`
      )
      queryPlanner = { ...shard, winningPlan: shard.winningPlan ?? shard }
      const esShards = isObj(es?.executionStages) ? (es!.executionStages as Doc).shards : undefined
      if (Array.isArray(esShards) && isObj(esShards[0])) executionStats = { ...es, ...(esShards[0] as Doc) }
    }
    const qwp = queryPlanner.winningPlan as Doc | undefined
    const sbe =
      version === '2' ||
      (isObj(qwp) && isObj(qwp.slotBasedPlan)) ||
      (isObj(qwp) && isObj(qwp.queryPlan) && !qwp.stage)
    return { queryPlanner, executionStats, sbe }
  }
  if (isObj(explain.queryPlanner))
    return from(explain.queryPlanner, isObj(explain.executionStats) ? explain.executionStats : null)
  if (Array.isArray(explain.stages)) {
    const first = explain.stages[0] as Doc | undefined
    const cursor = first && isObj(first.$cursor) ? first.$cursor : null
    if (cursor && isObj(cursor.queryPlanner))
      return from(cursor.queryPlanner, isObj(cursor.executionStats) ? cursor.executionStats : null)
  }
  if (isObj(explain.shards)) {
    const [name, shard] = Object.entries(explain.shards)[0] ?? []
    if (isObj(shard)) {
      notes.push(`Sharded collection: showing the plan of shard ${name}.`)
      return planSource(shard, [])
    }
  }
  return null
}

/** Pipeline stages after the $cursor stage, as nodes (each wraps the previous). */
function pipelineStages(explain: Doc, base: PlanNode): PlanNode {
  if (!Array.isArray(explain.stages)) return base
  let node = base
  for (const st of (explain.stages as Doc[]).slice(1)) {
    const op = Object.keys(st).find((k) => k.startsWith('$')) ?? '?'
    const spec = st[op]
    node = {
      stage: op,
      details: spec !== undefined ? [brief(spec)] : [],
      nReturned: num(st.nReturned),
      docsExamined: null,
      keysExamined: null,
      ms: num(st.executionTimeMillisEstimate),
      kind: op === '$sort' ? 'sort' : 'stage',
      children: [node]
    }
  }
  return node
}

// ---------------------------------------------------------------- index suggestion (ESR)

const EQUALITY_OPS = new Set(['$eq', '$in'])
const isPlain = (v: unknown): v is Doc =>
  isObj(v) && !(v as { _bsontype?: string })._bsontype && !(v instanceof Date) && !(v instanceof RegExp)

/**
 * Suggests an index for a filter + sort by the Equality, Sort, Range rule. Ignores what an
 * index can't serve ($or, $expr, $text, $where…). Null if nothing indexable.
 */
export function suggestIndexKeys(
  filter: Doc | null | undefined,
  sort?: Doc | [string, unknown][] | null
): { field: string; direction: 1 | -1 }[] | null {
  const eq: string[] = []
  const range: string[] = []
  const visit = (f: Doc) => {
    for (const [k, v] of Object.entries(f)) {
      if (k === '$and' && Array.isArray(v)) {
        for (const x of v) if (isPlain(x)) visit(x)
        continue
      }
      if (k.startsWith('$')) continue
      if (isPlain(v)) {
        const ops = Object.keys(v)
        if (!ops.length || !ops.some((o) => o.startsWith('$')))
          eq.push(k) // embedded document equality
        else if (ops.every((o) => EQUALITY_OPS.has(o))) eq.push(k)
        else range.push(k)
      } else if (v instanceof RegExp || (v as { _bsontype?: string })?._bsontype === 'BSONRegExp')
        range.push(k)
      else eq.push(k)
    }
  }
  if (filter) visit(filter)
  const out: { field: string; direction: 1 | -1 }[] = []
  const add = (field: string, direction: 1 | -1) => {
    if (!out.some((o) => o.field === field)) out.push({ field, direction })
  }
  for (const f of eq) add(f, 1)
  const sortPairs = Array.isArray(sort) ? sort : sort ? Object.entries(sort) : []
  for (const [f, d] of sortPairs) add(f, (num(d) ?? 1) < 0 ? -1 : 1)
  for (const f of range) add(f, 1)
  return out.length ? out.slice(0, 6) : null
}

const keyTextOf = (fields: { field: string; direction: 1 | -1 }[]) =>
  `{ ${fields.map((f) => `${/^[A-Za-z_$][\w$]*$/.test(f.field) ? f.field : JSON.stringify(f.field)}: ${f.direction}`).join(', ')} }`

const sameKeys = (fields: { field: string; direction: 1 | -1 }[], key: Doc) => {
  const entries = Object.entries(key)
  return (
    entries.length === fields.length &&
    entries.every(([k, v], i) => fields[i]!.field === k && num(v) === fields[i]!.direction)
  )
}

// ---------------------------------------------------------------- analysis

export interface AnalyzeContext {
  kind: 'find' | 'aggregate'
  /** The query filter (find) or the pipeline's leading $match. */
  filter: Doc | null
  /** Sort that applies to the collection (find sort, or a $sort right after the leading $match). */
  sort: Doc | null
  docCount: number | null
  /** Key patterns of the collection's indexes. */
  indexKeys: Doc[]
}

export function analyzeExplain(explain: Doc, ctx: AnalyzeContext): Omit<ExplainResult, 'raw'> {
  const notes: string[] = []
  const src = planSource(explain, notes)
  let base: PlanNode
  if (!src) {
    base = {
      stage: 'UNKNOWN',
      details: ['Unrecognised explain format: see the raw output.'],
      nReturned: null,
      docsExamined: null,
      keysExamined: null,
      ms: null,
      kind: 'other',
      children: []
    }
  } else if (!src.sbe && isObj(src.executionStats?.executionStages)) {
    base = toNode(src.executionStats.executionStages)
  } else {
    const wp = src.queryPlanner.winningPlan as Doc
    const plan = isObj(wp?.queryPlan) ? wp.queryPlan : wp
    base = isObj(plan) ? toNode(plan) : toNode({ stage: 'UNKNOWN' })
    if (src.sbe) notes.push('Slot-based execution engine: per-stage counts aren’t available, totals are.')
    // Put the totals on the plan's root.
    const es = src.executionStats
    if (es) {
      base.nReturned ??= num(es.nReturned)
      base.docsExamined ??= num(es.totalDocsExamined)
      base.keysExamined ??= num(es.totalKeysExamined)
    }
  }
  const tree = pipelineStages(explain, base)

  const indexes = new Set<string>()
  let collscan = false
  let planSort = false
  walk(base, (n) => {
    if (n.kind === 'collscan') collscan = true
    if (n.kind === 'ixscan') {
      const idx = n.details.find((d) => d.startsWith('index '))
      if (idx) indexes.add(idx.slice(6).split(' ')[0]!)
    }
    if (n.kind === 'sort') planSort = true
  })
  // A $sort stage that runs right on the collection's documents (not after $group etc.).
  const stages = Array.isArray(explain.stages) ? (explain.stages as Doc[]) : []
  const pipelineSortOnCollection =
    stages.length > 1 && Object.keys(stages[1]!).includes('$sort') && ctx.sort !== null
  const inMemorySort = planSort || pipelineSortOnCollection

  const es = src?.executionStats ?? null
  const lastStage = stages.at(-1)
  const summary: ExplainSummary = {
    executionTimeMs: num(es?.executionTimeMillis) ?? num(lastStage?.executionTimeMillisEstimate) ?? tree.ms,
    nReturned: stages.length > 1 ? num(lastStage?.nReturned) : num(es?.nReturned),
    docsExamined: num(es?.totalDocsExamined),
    keysExamined: num(es?.totalKeysExamined),
    indexes: [...indexes],
    collscan,
    inMemorySort,
    engine: src?.sbe ? 'sbe' : 'classic',
    docCount: ctx.docCount
  }

  const hints: ExplainHint[] = []
  const docs = summary.docsExamined ?? 0
  const returned = summary.nReturned ?? 0
  if (collscan && (ctx.docCount ?? docs) >= LARGE_COLLECTION)
    hints.push({
      kind: 'collscan',
      message: `Collection scan: no index was used, so all ${docs.toLocaleString()} documents were read.`
    })
  if (inMemorySort && ctx.sort)
    hints.push({
      kind: 'sort',
      message: 'Sorted in memory: no index provides this order, so results are sorted after reading them.'
    })
  const ratio = docs / Math.max(returned, 1)
  if (!collscan && docs >= 100 && ratio >= RATIO_LIMIT)
    hints.push({
      kind: 'ratio',
      message: `Examined ${docs.toLocaleString()} documents to return ${returned.toLocaleString()} (${Math.round(ratio)}× more than needed).`
    })

  let suggestion: IndexSuggestion | null = null
  if (hints.length) {
    const fields = suggestIndexKeys(ctx.filter, ctx.sort)
    if (fields) {
      const exists = ctx.indexKeys.some((k) => sameKeys(fields, k))
      suggestion = {
        fields,
        keyText: keyTextOf(fields),
        name: fields.map((f) => `${f.field}_${f.direction}`).join('_'),
        exists
      }
      if (exists)
        hints.push({
          kind: 'unused-index',
          message: `An index on ${suggestion.keyText} exists but wasn’t chosen; the planner preferred another plan (hint it to compare).`
        })
    }
  }
  return { summary, tree, hints, suggestion, notes }
}

/**
 * Turns @mongodb-js/mongodb-schema output into the Schema tab's field tree: types with their
 * share, presence, and a chart per type (histogram for numbers and dates, top values for
 * strings, booleans and ObjectIds). Values come from the analyser's sampled reservoir.
 */
import type { Schema, SchemaField, SchemaType } from '@mongodb-js/mongodb-schema'
import type { BsonTypeTag } from '@shared/bson-types'
import type { HistogramBin, SchemaChart, SchemaFieldInfo, SchemaTypeInfo, TopValue } from '@shared/schema'
import { toShellString } from '@shared/shell-format'

const TAG: Record<string, BsonTypeTag> = {
  String: 'string',
  Int32: 'int32',
  Long: 'int64',
  Double: 'double',
  Number: 'double',
  Decimal128: 'decimal128',
  Boolean: 'boolean',
  Date: 'date',
  ObjectId: 'objectId',
  Null: 'null',
  Binary: 'binary',
  Timestamp: 'timestamp',
  BSONRegExp: 'regex',
  RegExp: 'regex',
  MinKey: 'minKey',
  MaxKey: 'maxKey',
  Code: 'code',
  CodeWScope: 'code',
  BSONSymbol: 'symbol',
  Symbol: 'symbol',
  DBRef: 'dbref',
  Document: 'object',
  Array: 'array'
}

const NUMERIC = new Set<BsonTypeTag>(['int32', 'int64', 'double', 'decimal128'])
const TOP_VALUES = 10
const BINS = 12

type Typed = SchemaType & {
  values?: unknown[]
  types?: SchemaType[]
  fields?: SchemaField[]
  averageLength?: number
  totalCount?: number
}

const toNumber = (v: unknown): number => (typeof v === 'number' ? v : Number(String(v)))

function compact(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`
  if (Number.isInteger(n)) return String(n)
  return n.toPrecision(3)
}

function topValues(
  values: unknown[],
  text: (v: unknown) => string,
  label: (v: unknown) => string
): SchemaChart {
  const counts = new Map<string, { value: unknown; count: number }>()
  for (const v of values) {
    const k = text(v)
    const e = counts.get(k)
    if (e) e.count++
    else counts.set(k, { value: v, count: 1 })
  }
  // Most frequent first; ties alphabetically so the order is stable between samples.
  const sorted = [...counts.entries()].sort(
    (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  )
  const top: TopValue[] = sorted.slice(0, TOP_VALUES).map(([k, e]) => {
    const l = label(e.value)
    return { valueText: k, label: l.length > 40 ? `${l.slice(0, 39)}…` : l, count: e.count }
  })
  return { kind: 'top', values: top, distinct: counts.size, sampled: values.length }
}

function histogram(nums: number[], kind: 'number' | 'date'): SchemaChart {
  let min = Infinity
  let max = -Infinity
  for (const n of nums) {
    if (n < min) min = n
    if (n > max) max = n
  }
  const span = max - min || 1
  const width = span / BINS
  const counts = new Array<number>(BINS).fill(0)
  for (const n of nums) counts[Math.min(BINS - 1, Math.floor((n - min) / width))]!++
  const dateLabel = (ms: number) => {
    const iso = new Date(ms).toISOString()
    return span < 2 * 86_400_000 ? iso.slice(5, 16).replace('T', ' ') : iso.slice(0, 10)
  }
  const text = (n: number) => (kind === 'date' ? `ISODate("${new Date(n).toISOString()}")` : String(n))
  const label = (n: number) => (kind === 'date' ? dateLabel(n) : compact(n))
  const bins: HistogramBin[] = counts.map((count, i) => {
    const lo = min + i * width
    const hi = i === BINS - 1 ? max : min + (i + 1) * width
    return { loText: text(lo), hiText: text(hi), loLabel: label(lo), hiLabel: label(hi), count }
  })
  return { kind: 'histogram', valueKind: kind, bins, min: label(min), max: label(max) }
}

function chartFor(tag: BsonTypeTag, values: unknown[] | undefined): SchemaChart | null {
  if (!values?.length) return null
  if (NUMERIC.has(tag)) {
    const distinct = new Set(values.map((v) => String(v)))
    if (distinct.size <= TOP_VALUES)
      return topValues(
        values,
        (v) => toShellString(v, 0),
        (v) => String(v)
      )
    return histogram(values.map(toNumber).filter(Number.isFinite), 'number')
  }
  if (tag === 'date') {
    const ms = values.map((v) => (v instanceof Date ? v.getTime() : NaN)).filter(Number.isFinite)
    if (new Set(ms).size <= TOP_VALUES)
      return topValues(
        values,
        (v) => toShellString(v, 0),
        (v) => (v instanceof Date ? v.toISOString() : String(v))
      )
    return histogram(ms, 'date')
  }
  if (tag === 'string')
    return topValues(
      values,
      (v) => JSON.stringify(v),
      (v) => JSON.stringify(v)
    )
  if (tag === 'boolean')
    return topValues(
      values,
      (v) => String(v),
      (v) => String(v)
    )
  if (tag === 'objectId')
    return topValues(
      values,
      (v) => toShellString(v, 0),
      (v) => String(v)
    )
  return null
}

function typeInfo(t: Typed, total: number): SchemaTypeInfo | null {
  const tag = TAG[t.name] ?? TAG[t.bsonType]
  if (!tag || t.name === 'Undefined') return null
  return {
    type: tag,
    probability: total ? t.count / total : 0,
    count: t.count,
    chart: chartFor(tag, t.values),
    ...(t.name === 'Array' && typeof t.averageLength === 'number' ? { averageLength: t.averageLength } : {})
  }
}

function convertField(f: SchemaField, prefix: string, depth: number, parentCount: number): SchemaFieldInfo {
  const path = prefix ? `${prefix}.${f.name}` : f.name
  const types = (f.types as Typed[]).map((t) => typeInfo(t, f.count)).filter((t): t is SchemaTypeInfo => !!t)
  // Nested fields: from documents, and from documents inside arrays (same path, Mongo style).
  const children: SchemaFieldInfo[] = []
  const collect = (ts: Typed[]) => {
    for (const t of ts) {
      if (t.name === 'Document' && t.fields)
        for (const c of t.fields) children.push(convertField(c, path, depth + 1, t.count))
      if (t.name === 'Array' && t.types) collect(t.types as Typed[])
    }
  }
  collect(f.types as Typed[])
  return {
    path,
    name: f.name,
    depth,
    probability: parentCount ? f.count / parentCount : 0,
    count: f.count,
    types: types.sort((a, b) => b.count - a.count),
    children: mergeSamePath(children)
  }
}

/** A field can appear both as a sub-document field and inside an array of documents: merge them. */
function mergeSamePath(fields: SchemaFieldInfo[]): SchemaFieldInfo[] {
  const byPath = new Map<string, SchemaFieldInfo>()
  for (const f of fields) {
    const e = byPath.get(f.path)
    if (!e) byPath.set(f.path, f)
    else {
      e.count += f.count
      e.probability = Math.max(e.probability, f.probability)
      e.types.push(...f.types)
      e.children = mergeSamePath([...e.children, ...f.children])
    }
  }
  return [...byPath.values()]
}

export function toSchemaFields(schema: Schema): SchemaFieldInfo[] {
  return schema.fields.map((f) => convertField(f, '', 0, schema.count))
}

/**
 * BSON type detection and display text for the document views.
 * Works on values deserialized from canonical EJSON (bson classes, checked via `_bsontype`).
 */
import { formatScalar } from './shell-format'

export type BsonTypeTag =
  | 'string'
  | 'int32'
  | 'int64'
  | 'double'
  | 'decimal128'
  | 'boolean'
  | 'date'
  | 'objectId'
  | 'null'
  | 'undefined'
  | 'binary'
  | 'uuid'
  | 'timestamp'
  | 'regex'
  | 'minKey'
  | 'maxKey'
  | 'code'
  | 'symbol'
  | 'dbref'
  | 'object'
  | 'array'

export const bsonTypeLabel: Record<BsonTypeTag, string> = {
  string: 'String',
  int32: 'Int32',
  int64: 'Int64',
  double: 'Double',
  decimal128: 'Decimal128',
  boolean: 'Boolean',
  date: 'Date',
  objectId: 'ObjectId',
  null: 'Null',
  undefined: 'Undefined',
  binary: 'Binary',
  uuid: 'UUID',
  timestamp: 'Timestamp',
  regex: 'Regex',
  minKey: 'MinKey',
  maxKey: 'MaxKey',
  code: 'Code',
  symbol: 'Symbol',
  dbref: 'DBRef',
  object: 'Object',
  array: 'Array'
}

const BINARY_SUBTYPES: Record<number, string> = {
  0: 'generic',
  1: 'function',
  2: 'binary (old)',
  3: 'UUID (old)',
  4: 'UUID',
  5: 'MD5',
  6: 'encrypted',
  7: 'compressed column',
  8: 'sensitive',
  9: 'vector'
}

export function bsonTypeOf(v: unknown): BsonTypeTag {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= 2147483647 ? 'int32' : 'double'
  if (typeof v === 'bigint') return 'int64'
  if (v instanceof Date) return 'date'
  if (v instanceof RegExp) return 'regex'
  if (Array.isArray(v)) return 'array'
  switch ((v as { _bsontype?: string })._bsontype) {
    case 'ObjectId':
    case 'ObjectID':
      return 'objectId'
    case 'Int32':
      return 'int32'
    case 'Long':
      return 'int64'
    case 'Double':
      return 'double'
    case 'Decimal128':
      return 'decimal128'
    case 'Binary': {
      const b = v as { sub_type: number; buffer: Uint8Array }
      return b.sub_type === 4 && b.buffer.length === 16 ? 'uuid' : 'binary'
    }
    case 'Timestamp':
      return 'timestamp'
    case 'BSONRegExp':
      return 'regex'
    case 'MinKey':
      return 'minKey'
    case 'MaxKey':
      return 'maxKey'
    case 'Code':
      return 'code'
    case 'BSONSymbol':
    case 'Symbol':
      return 'symbol'
    case 'DBRef':
      return 'dbref'
    default:
      return 'object'
  }
}

export const isContainer = (t: BsonTypeTag) => t === 'object' || t === 'array'

function formatDoubleDisplay(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity'
  if (Object.is(n, -0)) return '-0.0'
  return Number.isInteger(n) ? `${n}.0` : String(n)
}

/**
 * Like displayScalar, but formats at most `maxChars` of huge strings/binaries (a 10 MB string
 * shouldn't be JSON-encoded in full to show 300 characters).
 */
export function displayScalarPreview(
  v: unknown,
  tag: BsonTypeTag,
  maxChars: number
): { text: string; truncated: boolean } {
  if (tag === 'string' && (v as string).length > maxChars)
    return { text: JSON.stringify((v as string).slice(0, maxChars)).slice(0, -1), truncated: true }
  if (tag === 'binary') {
    const b = v as { sub_type: number; buffer: Uint8Array }
    const maxBytes = Math.ceil(maxChars * 0.75)
    if (b.buffer.length > maxBytes) {
      const head = Array.from(b.buffer.subarray(0, maxBytes), (x) => String.fromCharCode(x)).join('')
      return { text: `BinData(${b.sub_type}, "${btoa(head)}`, truncated: true }
    }
  }
  const text = displayScalar(v, tag)
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false }
}

/** Compact, human-oriented text for a scalar (containers return ''). */
export function displayScalar(v: unknown, tag: BsonTypeTag = bsonTypeOf(v)): string {
  switch (tag) {
    case 'string':
      return JSON.stringify(v)
    case 'int32':
      return String(typeof v === 'number' ? v : (v as { value: number }).value)
    case 'int64':
    case 'decimal128':
      return String(v)
    case 'double':
      return formatDoubleDisplay(typeof v === 'number' ? v : (v as { value: number }).value)
    case 'boolean':
      return String(v)
    case 'null':
      return 'null'
    case 'undefined':
      return 'undefined'
    case 'date': {
      const d = v as Date
      return Number.isNaN(d.getTime()) ? 'Invalid Date' : d.toISOString()
    }
    case 'regex': {
      if (v instanceof RegExp) return `/${v.source}/${v.flags}`
      const r = v as { pattern: string; options: string }
      return `/${r.pattern}/${r.options}`
    }
    case 'binary': {
      const b = v as { sub_type: number; toString(enc: 'base64'): string }
      return `BinData(${b.sub_type}, "${b.toString('base64')}")`
    }
    case 'object':
    case 'array':
      return ''
    default:
      return formatScalar(v) ?? String(v)
  }
}

/** Extra detail for tooltips (embedded ObjectId time, local/UTC dates, binary subtype...). */
export function describeValue(v: unknown, tag: BsonTypeTag = bsonTypeOf(v)): string {
  const label = bsonTypeLabel[tag]
  switch (tag) {
    case 'objectId': {
      const ts = (v as { getTimestamp(): Date }).getTimestamp()
      return `${label} · created ${ts.toISOString()} (${ts.toLocaleString()})`
    }
    case 'date': {
      const d = v as Date
      return Number.isNaN(d.getTime())
        ? label
        : `${label} · UTC ${d.toISOString()} · local ${d.toLocaleString()}`
    }
    case 'binary': {
      const b = v as { sub_type: number; buffer: Uint8Array }
      return `${label} · subtype ${b.sub_type} (${BINARY_SUBTYPES[b.sub_type] ?? 'user-defined'}) · ${b.buffer.length} bytes`
    }
    case 'timestamp': {
      const t = v as { t: number; i: number }
      return `${label} · ${new Date(t.t * 1000).toISOString()} · increment ${t.i}`
    }
    case 'string':
      return `${label} · ${(v as string).length} characters`
    default:
      return label
  }
}

/**
 * Inline value editing: the text a person edits for each BSON type, parsing it back, and
 * converting between types from the type dropdown. Conversions never guess: if the value doesn't
 * fit the target type, you get an error instead of a silent change.
 */
import { Binary, BSONRegExp, Decimal128, Double, Int32, Long, ObjectId, Timestamp, UUID } from 'bson'
import { bsonTypeLabel, bsonTypeOf, type BsonTypeTag } from './bson-types'

export const editableTypes = [
  'string',
  'int32',
  'int64',
  'double',
  'decimal128',
  'boolean',
  'date',
  'objectId',
  'null',
  'object',
  'array',
  'binary',
  'uuid',
  'timestamp',
  'regex'
] as const satisfies readonly BsonTypeTag[]
export type EditableType = (typeof editableTypes)[number]

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string }

const fail = (error: string): ParseResult => ({ ok: false, error })
const ok = (value: unknown): ParseResult => ({ ok: true, value })

function uuidOf(bytes: Uint8Array): string {
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function numberOf(v: unknown): number {
  return typeof v === 'number' ? v : (v as { value: number }).value
}

/** The text shown in the inline editor for a scalar value. */
export function editText(v: unknown): string {
  const tag = bsonTypeOf(v)
  switch (tag) {
    case 'string':
      return v as string
    case 'int32':
      return String(numberOf(v))
    case 'double': {
      const n = numberOf(v)
      return Object.is(n, -0) ? '-0' : String(n)
    }
    case 'int64':
    case 'decimal128':
      return String(v)
    case 'boolean':
      return String(v)
    case 'date': {
      const d = v as Date
      return Number.isNaN(d.getTime()) ? '' : d.toISOString()
    }
    case 'objectId':
      return (v as ObjectId).toHexString()
    case 'null':
    case 'undefined':
      return ''
    case 'binary':
      return (v as Binary).toString('base64')
    case 'uuid':
      return uuidOf((v as Binary).buffer)
    case 'timestamp': {
      const t = v as Timestamp
      return `${t.t} ${t.i}`
    }
    case 'regex': {
      if (v instanceof RegExp) return `/${v.source}/${v.flags}`
      const r = v as BSONRegExp
      return `/${r.pattern}/${r.options}`
    }
    default:
      return ''
  }
}

const INT = /^[+-]?\d+$/

/** Parses editor text as `type`. `previous` keeps details like a binary subtype. */
export function parseEditValue(text: string, type: BsonTypeTag, previous?: unknown): ParseResult {
  const t = text.trim()
  const label = bsonTypeLabel[type]
  switch (type) {
    case 'string':
      return ok(text)
    case 'int32': {
      if (!INT.test(t)) return fail(`${label} must be a whole number`)
      const n = Number(t)
      if (n < -2147483648 || n > 2147483647)
        return fail(`${label} must be between -2147483648 and 2147483647`)
      return ok(new Int32(n))
    }
    case 'int64': {
      if (!INT.test(t)) return fail(`${label} must be a whole number`)
      const l = Long.fromString(t)
      if (l.toString() !== BigInt(t).toString()) return fail(`${label} must be between -2^63 and 2^63-1`)
      return ok(l)
    }
    case 'double': {
      if (/^[+-]?(Infinity|NaN)$/.test(t)) return ok(new Double(Number(t)))
      if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t))
        return fail(`${label} must be a number`)
      return ok(new Double(Number(t)))
    }
    case 'decimal128':
      try {
        if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$|^[+-]?(Infinity|NaN|Inf)$/i.test(t)) throw new Error()
        return ok(Decimal128.fromString(t))
      } catch {
        return fail(`${label} must be a decimal number, like 10.50`)
      }
    case 'boolean':
      if (t === 'true') return ok(true)
      if (t === 'false') return ok(false)
      return fail(`${label} must be true or false`)
    case 'date': {
      const ms = Date.parse(t)
      if (!/^\d{4}-\d{2}-\d{2}/.test(t) || Number.isNaN(ms))
        return fail(`${label} must be an ISO date, like 2026-01-15T10:30:00Z`)
      return ok(new Date(ms))
    }
    case 'objectId':
      return /^[0-9a-f]{24}$/i.test(t) ? ok(new ObjectId(t)) : fail(`${label} must be 24 hex characters`)
    case 'null':
      return ok(null)
    case 'object':
      return ok({})
    case 'array':
      return ok([])
    case 'binary': {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 !== 0) return fail(`${label} must be base64`)
      const sub = (previous as Binary | undefined)?._bsontype === 'Binary' ? (previous as Binary).sub_type : 0
      return ok(Binary.createFromBase64(t, sub === 4 ? 0 : sub))
    }
    case 'uuid':
      try {
        if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(t)) throw new Error()
        return ok(new UUID(t).toBinary())
      } catch {
        return fail(`${label} must look like 3b241101-e2bb-4255-8caf-4136c566a962`)
      }
    case 'timestamp': {
      const m = /^(\d+)[\s,]+(\d+)$/.exec(t)
      if (!m) return fail(`${label} must be "seconds increment", like 1700000000 1`)
      return ok(new Timestamp({ t: Number(m[1]), i: Number(m[2]) }))
    }
    case 'regex': {
      const m = /^\/(.*)\/([a-z]*)$/s.exec(t)
      if (!m) return fail(`${label} must look like /pattern/flags`)
      if (/[^imxsu]/.test(m[2]!)) return fail('Regex flags can only be i, m, x, s, u')
      return ok(new BSONRegExp(m[1]!, m[2]!))
    }
    default:
      return fail(`${label} values can't be edited inline`)
  }
}

/** Converts a value (or its editor text) to another type, or explains why it can't. */
export function convertValue(value: unknown, to: BsonTypeTag): ParseResult {
  if (to === 'null' || to === 'object' || to === 'array') return parseEditValue('', to)
  const text = typeof value === 'string' ? value : editText(value)
  if (to === 'string') return ok(text)
  const from = typeof value === 'string' ? 'string' : bsonTypeOf(value)
  // Number → date is ambiguous (seconds? ms?); ask for an ISO date instead.
  if (to === 'date' && from !== 'string' && from !== 'date')
    return fail('Type an ISO date to convert to Date')
  const res = parseEditValue(text, to, value)
  if (!res.ok)
    return fail(
      `Can't convert ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)} to ${bsonTypeLabel[to]}: ${res.error}`
    )
  return res
}

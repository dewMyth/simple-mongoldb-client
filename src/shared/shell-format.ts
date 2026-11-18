/**
 * BSON value → mongosh/Compass shell syntax, e.g. { _id: ObjectId('…'), n: NumberLong('5') }.
 *
 * The output is designed to round-trip through mongodb-query-parser with every type intact:
 * whole-number doubles are written Double(10) (a bare 10 would parse as Int32), Int64 is always
 * NumberLong('…') (strings keep precision past 2^53), and so on.
 *
 * Known limit: regexes using the "s" or "x" flags have no shell form the parser accepts.
 */

type Bsonish = { _bsontype?: string } & Record<string, unknown>

const IDENT = /^[A-Za-z_$][\w$]*$/

export function shellKey(key: string): string {
  return IDENT.test(key) ? key : JSON.stringify(key)
}

const str = (s: string) => JSON.stringify(s)

function formatDouble(n: number): string {
  if (Number.isNaN(n)) return 'Double(NaN)'
  if (n === Infinity) return 'Double(Infinity)'
  if (n === -Infinity) return 'Double(-Infinity)'
  if (Object.is(n, -0)) return 'Double(-0)'
  if (Number.isInteger(n)) return `Double(${n})`
  return String(n)
}

function formatDate(d: Date): string {
  const t = d.getTime()
  if (Number.isNaN(t)) return 'new Date(NaN)'
  const y = d.getUTCFullYear()
  return y >= 0 && y <= 9999 ? `ISODate(${str(d.toISOString())})` : `new Date(${t})`
}

function uuidString(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Formats a single scalar BSON value. Returns null for objects/arrays. */
export function formatScalar(v: unknown): string | null {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return str(v)
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number')
    return Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) <= 2147483647 ? String(v) : formatDouble(v)
  if (typeof v === 'bigint') return `NumberLong(${str(v.toString())})`
  if (v instanceof Date) return formatDate(v)
  if (v instanceof RegExp) return `RegExp(${str(v.source)}, ${str(v.flags)})`
  const b = v as Bsonish
  switch (b._bsontype) {
    case 'ObjectId':
    case 'ObjectID':
      return `ObjectId(${str((b as unknown as { toHexString(): string }).toHexString())})`
    case 'Int32':
      return String((b as unknown as { value: number }).value)
    case 'Double':
      return formatDouble((b as unknown as { value: number }).value)
    case 'Long':
      return `NumberLong(${str(String(b))})`
    case 'Decimal128':
      return `NumberDecimal(${str(String(b))})`
    case 'Binary': {
      const bin = b as unknown as { sub_type: number; buffer: Uint8Array; toString(enc: 'base64'): string }
      if (bin.sub_type === 4 && bin.buffer.length === 16) return `UUID(${str(uuidString(bin.buffer))})`
      return `BinData(${bin.sub_type}, ${str(bin.toString('base64'))})`
    }
    case 'Timestamp': {
      const ts = b as unknown as { t: number; i: number }
      return `Timestamp({ t: ${ts.t}, i: ${ts.i} })`
    }
    case 'BSONRegExp': {
      const r = b as unknown as { pattern: string; options: string }
      return `RegExp(${str(r.pattern)}, ${str(r.options)})`
    }
    case 'MinKey':
      return 'MinKey()'
    case 'MaxKey':
      return 'MaxKey()'
    case 'BSONSymbol':
    case 'Symbol':
      return `Symbol(${str(String((b as unknown as { value: string }).value))})`
    case 'Code': {
      const c = b as unknown as { code: string; scope?: Record<string, unknown> | null }
      return c.scope ? `Code(${str(c.code)}, ${toShellString(c.scope, 0, 0)})` : `Code(${str(c.code)})`
    }
    case 'DBRef': {
      const r = b as unknown as { collection: string; oid: unknown; db?: string }
      const id = formatScalar(r.oid) ?? toShellString(r.oid, 0, 0)
      return r.db ? `DBRef(${str(r.collection)}, ${id}, ${str(r.db)})` : `DBRef(${str(r.collection)}, ${id})`
    }
    default:
      return null
  }
}

class BudgetExceeded extends Error {}

interface Writer {
  parts: string[]
  length: number
  max: number
}

function write(w: Writer, s: string) {
  w.parts.push(s)
  w.length += s.length
  if (w.length > w.max) throw new BudgetExceeded()
}

function emit(w: Writer, value: unknown, indent: number, level: number) {
  const remaining = w.max - w.length
  if (remaining < Infinity) {
    // Huge strings/binaries: format only what can still fit (the writer then stops).
    if (typeof value === 'string' && value.length > remaining)
      return write(w, JSON.stringify(value.slice(0, remaining)))
    const bin = value as { _bsontype?: string; sub_type?: number; buffer?: Uint8Array }
    if (bin?._bsontype === 'Binary' && bin.buffer && bin.buffer.length > remaining) {
      const head = Array.from(bin.buffer.subarray(0, Math.ceil(remaining * 0.75)), (b) =>
        String.fromCharCode(b)
      ).join('')
      return write(w, `BinData(${bin.sub_type}, "${btoa(head)}`)
    }
  }
  const scalar = formatScalar(value)
  if (scalar !== null) return write(w, scalar)
  const pad = indent ? '\n' + ' '.repeat(indent * (level + 1)) : ' '
  const end = indent ? '\n' + ' '.repeat(indent * level) : ' '
  if (Array.isArray(value)) {
    if (!value.length) return write(w, '[]')
    write(w, indent ? `[${pad}` : '[')
    value.forEach((v, i) => {
      if (i) write(w, indent ? `,${pad}` : ', ')
      emit(w, v, indent, level + 1)
    })
    return write(w, indent ? `${end}]` : ']')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return write(w, '{}')
  write(w, indent ? `{${pad}` : '{ ')
  entries.forEach(([k, v], i) => {
    if (i) write(w, indent ? `,${pad}` : ', ')
    write(w, `${shellKey(k)}: `)
    emit(w, v, indent, level + 1)
  })
  write(w, indent ? `${end}}` : ' }')
}

/**
 * Full shell-syntax rendering. `indent` = spaces per level (0 = single line).
 */
export function toShellString(value: unknown, indent = 2, level = 0): string {
  const w: Writer = { parts: [], length: 0, max: Infinity }
  emit(w, value, indent, level)
  return w.parts.join('')
}

/**
 * Like toShellString, but stops once `maxLength` characters have been produced, so previewing a
 * huge document costs about as much as the preview itself.
 */
export function toShellPreview(
  value: unknown,
  maxLength: number,
  indent = 2
): { text: string; truncated: boolean } {
  const w: Writer = { parts: [], length: 0, max: maxLength }
  try {
    emit(w, value, indent, 0)
    return { text: w.parts.join(''), truncated: false }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e
    return { text: w.parts.join('').slice(0, maxLength), truncated: true }
  }
}

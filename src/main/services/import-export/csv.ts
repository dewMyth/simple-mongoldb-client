/**
 * CSV for import/export: a streaming RFC 4180 reader, cell writing, flattening documents to
 * dotted columns, and typed conversion of cells (per-column type picker).
 */
import { Binary, Decimal128, EJSON, Int32, Long, ObjectId, type Document } from 'bson'
import type { CsvColumnType } from '@shared/import-export'

/** Streaming CSV reader: quotes, escaped quotes, quoted newlines, CRLF/LF. */
export class CsvReader {
  private field = ''
  private row: string[] = []
  private inQuotes = false
  /** A quote was just closed inside a quoted field ("" escape or end of field). */
  private quoteSeen = false
  private started = false
  /** The previous chunk ended with "\r": a "\n" starting this one belongs to it. */
  private afterCR = false

  feed(chunk: string): string[][] {
    const rows: string[][] = []
    let i = 0
    if (!this.started) {
      this.started = true
      if (chunk.charCodeAt(0) === 0xfeff) i = 1
    }
    if (this.afterCR && chunk[i] === '\n' && !this.inQuotes) i++
    this.afterCR = false
    for (; i < chunk.length; i++) {
      const c = chunk[i]!
      if (this.inQuotes) {
        if (this.quoteSeen) {
          this.quoteSeen = false
          if (c === '"') {
            this.field += '"'
            continue
          }
          this.inQuotes = false // the quote closed the field; fall through to handle c
        } else if (c === '"') {
          this.quoteSeen = true
          continue
        } else {
          this.field += c
          continue
        }
      }
      if (c === '"' && this.field === '') this.inQuotes = true
      else if (c === ',') {
        this.row.push(this.field)
        this.field = ''
      } else if (c === '\n' || c === '\r') {
        if (c === '\r') {
          if (i + 1 === chunk.length) this.afterCR = true
          else if (chunk[i + 1] === '\n') i++
        }
        this.row.push(this.field)
        this.field = ''
        rows.push(this.row)
        this.row = []
      } else this.field += c
    }
    return rows
  }

  end(): string[][] {
    if (this.inQuotes && !this.quoteSeen) throw new Error('The file ends inside a quoted value')
    if (this.field !== '' || this.row.length) {
      this.row.push(this.field)
      const r = this.row
      this.row = []
      this.field = ''
      return [r]
    }
    return []
  }
}

export function csvCell(text: string): string {
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

type Bsonish = { _bsontype?: string }

/** A BSON value as CSV text (types can't survive CSV; values are written readably). */
export function csvValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
  const t = (v as Bsonish)._bsontype
  if (t === 'Int32' || t === 'Double') return String((v as { value: number }).value)
  if (t === 'Long' || t === 'Decimal128') return String(v)
  if (t === 'ObjectId') return (v as ObjectId).toHexString()
  if (t === 'Binary') {
    const b = v as Binary
    return b.sub_type === 4 && b.buffer.length === 16 ? b.toUUID().toString() : b.toString('base64')
  }
  if (t === 'BSONRegExp')
    return `/${(v as { pattern: string }).pattern}/${(v as { options: string }).options}`
  // Objects, arrays and other BSON types: relaxed Extended JSON.
  return EJSON.stringify(v as Document, { relaxed: true })
}

/** Value at a dotted path; through arrays it collects values (like MongoDB paths do). */
export function valueAtPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc
  const parts = path.split('.')
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const rest = parts.slice(i).join('.')
      const vals = cur.map((el) => valueAtPath(el, rest)).filter((x) => x !== undefined)
      return vals.length ? vals : undefined
    }
    if (typeof cur !== 'object' || (cur as Bsonish)._bsontype || cur instanceof Date) return undefined
    cur = (cur as Record<string, unknown>)[parts[i]!]
  }
  return cur
}

export function csvRow(doc: Document, fields: string[]): string {
  return fields.map((f) => csvCell(csvValue(valueAtPath(doc, f)))).join(',')
}

// ---------------------------------------------------------------- import conversion

const INT = /^[+-]?\d+$/
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const HEX24 = /^[0-9a-f]{24}$/i
const BOOL = /^(true|false)$/i
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

/** The type that best fits a non-empty cell. */
export function detectCellType(text: string): Exclude<CsvColumnType, 'auto' | 'exclude'> {
  const t = text.trim()
  if (INT.test(t)) {
    const n = Number(t)
    return n >= INT32_MIN && n <= INT32_MAX ? 'int32' : 'int64'
  }
  if (NUMBER.test(t)) return 'double'
  if (BOOL.test(t)) return 'boolean'
  if (ISO_DATE.test(t) && !Number.isNaN(Date.parse(t))) return 'date'
  if (HEX24.test(t)) return 'objectId'
  return 'string'
}

/** A column's type from sample cells: the widest type that fits every non-empty cell. */
export function detectColumnType(cells: string[]): CsvColumnType {
  const types = new Set(cells.filter((c) => c.trim() !== '').map(detectCellType))
  if (!types.size) return 'string'
  if (types.size === 1) return [...types][0]!
  if ([...types].every((t) => t === 'int32' || t === 'int64')) return 'int64'
  if ([...types].every((t) => t === 'int32' || t === 'int64' || t === 'double')) return 'double'
  return 'string'
}

/** Converts a cell. Returns undefined to leave the field out. Throws a readable error. */
export function convertCell(text: string, type: CsvColumnType, ignoreEmpty: boolean): unknown {
  if (type === 'exclude') return undefined
  // Empty cells: left out, except as "" for string columns when empty values are kept.
  if (text === '') return type === 'string' && !ignoreEmpty ? '' : undefined
  const t = type === 'auto' ? detectCellType(text) : type
  const s = text.trim()
  switch (t) {
    case 'string':
      return text
    case 'int32': {
      const n = Number(s)
      if (!INT.test(s) || n < INT32_MIN || n > INT32_MAX) throw new Error(`"${text}" isn’t an Int32`)
      return new Int32(n)
    }
    case 'int64':
      if (!INT.test(s)) throw new Error(`"${text}" isn’t an Int64`)
      try {
        const l = Long.fromString(s)
        if (l.toString() !== s.replace(/^\+/, '').replace(/^(-?)0+(?=\d)/, '$1')) throw new Error()
        return l
      } catch {
        throw new Error(`"${text}" doesn’t fit an Int64`)
      }
    case 'double': {
      if (!NUMBER.test(s)) throw new Error(`"${text}" isn’t a number`)
      return Number(s)
    }
    case 'decimal128':
      try {
        return Decimal128.fromString(s)
      } catch {
        throw new Error(`"${text}" isn’t a Decimal128`)
      }
    case 'boolean':
      if (/^(true|1|yes)$/i.test(s)) return true
      if (/^(false|0|no)$/i.test(s)) return false
      throw new Error(`"${text}" isn’t a boolean`)
    case 'date': {
      const d = INT.test(s) ? new Date(Number(s)) : new Date(s)
      if (Number.isNaN(d.getTime())) throw new Error(`"${text}" isn’t a date`)
      return d
    }
    case 'objectId':
      if (!HEX24.test(s)) throw new Error(`"${text}" isn’t an ObjectId (24 hex characters)`)
      return new ObjectId(s)
  }
  return text
}

/** Builds a document from a CSV row: dotted headers become nested fields. */
export function rowToDocument(
  headers: string[],
  types: CsvColumnType[],
  row: string[],
  ignoreEmpty: boolean
): Document {
  const doc: Document = {}
  headers.forEach((h, i) => {
    const v = convertCell(row[i] ?? '', types[i] ?? 'auto', ignoreEmpty)
    if (v === undefined || !h) return
    const parts = h.split('.')
    let cur: Document = doc
    for (const p of parts.slice(0, -1)) {
      if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}
      cur = cur[p] as Document
    }
    cur[parts.at(-1)!] = v
  })
  return doc
}

/**
 * Export a query as runnable driver code: Node.js, Python (PyMongo), Java, C#, Go (driver v2)
 * and mongosh. Values are written with each language's exact BSON types (Int64 stays Int64,
 * whole-number doubles stay doubles, Binary keeps its subtype…), so the exported query matches
 * the same documents. The connection string is always read from MONGODB_URI: credentials are
 * never written into code.
 *
 * bson-transpilers was evaluated and not used: no UUID/BinData support, no mongosh output, and
 * its Go output targets the deprecated v1 driver.
 */
import { toShellString } from './shell-format'

export const exportLanguages = ['node', 'python', 'java', 'csharp', 'go', 'shell'] as const
export type ExportLanguage = (typeof exportLanguages)[number]
export type ExportMode = 'find' | 'count'

export const exportLanguageLabel: Record<ExportLanguage, string> = {
  node: 'Node.js',
  python: 'Python',
  java: 'Java',
  csharp: 'C#',
  go: 'Go',
  shell: 'mongosh'
}

export interface ExportableQuery {
  filter: Record<string, unknown>
  project?: Record<string, unknown>
  sort?: Record<string, unknown> | [string, 1 | -1][]
  collation?: Record<string, unknown>
  hint?: Record<string, unknown> | string
  skip?: number
  limit?: number
  maxTimeMS?: number
}

export interface ExportTarget {
  db: string
  collection: string
}

type Bsonish = { _bsontype?: string } & Record<string, unknown>
const bt = (v: unknown) => (v && typeof v === 'object' ? (v as Bsonish)._bsontype : undefined)
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !bt(v) &&
  !(v instanceof Date) &&
  !(v instanceof RegExp)

const str = (s: string) => JSON.stringify(s)

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
function base64Of(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
function uuidOf(bytes: Uint8Array): string {
  const h = hexOf(bytes)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

interface Scalar {
  kind: string
  v: unknown
}

/** Normalises a scalar into a tagged form shared by every language writer. */
function scalar(v: unknown): Scalar | null {
  if (v === null || v === undefined) return { kind: 'null', v: null }
  if (typeof v === 'string') return { kind: 'string', v }
  if (typeof v === 'boolean') return { kind: 'bool', v }
  if (typeof v === 'number')
    return Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) <= 2147483647
      ? { kind: 'int32', v }
      : { kind: 'double', v }
  if (typeof v === 'bigint') return { kind: 'int64', v: v.toString() }
  if (v instanceof Date) return { kind: 'date', v }
  if (v instanceof RegExp) return { kind: 'regex', v: { pattern: v.source, options: v.flags } }
  const b = v as Bsonish
  switch (b._bsontype) {
    case 'ObjectId':
    case 'ObjectID':
      return { kind: 'objectId', v: (b as unknown as { toHexString(): string }).toHexString() }
    case 'Int32':
      return { kind: 'int32', v: (b as unknown as { value: number }).value }
    case 'Double':
      return { kind: 'double', v: (b as unknown as { value: number }).value }
    case 'Long':
      return { kind: 'int64', v: String(b) }
    case 'Decimal128':
      return { kind: 'decimal', v: String(b) }
    case 'Binary': {
      const bin = b as unknown as { sub_type: number; buffer: Uint8Array }
      if (bin.sub_type === 4 && bin.buffer.length === 16) return { kind: 'uuid', v: uuidOf(bin.buffer) }
      return { kind: 'binary', v: { sub: bin.sub_type, b64: base64Of(bin.buffer) } }
    }
    case 'Timestamp': {
      const ts = b as unknown as { t: number; i: number }
      return { kind: 'timestamp', v: { t: ts.t, i: ts.i } }
    }
    case 'BSONRegExp': {
      const r = b as unknown as { pattern: string; options: string }
      return { kind: 'regex', v: { pattern: r.pattern, options: r.options } }
    }
    case 'MinKey':
      return { kind: 'minKey', v: null }
    case 'MaxKey':
      return { kind: 'maxKey', v: null }
    case 'BSONSymbol':
    case 'Symbol':
      return { kind: 'symbol', v: String((b as unknown as { value: string }).value) }
    case 'Code': {
      const c = b as unknown as { code: string; scope?: Record<string, unknown> | null }
      return { kind: 'code', v: { code: c.code, scope: c.scope ?? null } }
    }
    case 'DBRef': {
      const r = b as unknown as { collection: string; oid: unknown; db?: string }
      return { kind: 'dbref', v: r }
    }
  }
  return null
}

// ---------------------------------------------------------------- generic pretty printer

interface Lang {
  /** Renders a scalar; may register imports/helpers via `use`. */
  scalar(s: Scalar, render: (v: unknown, level: number) => string, level: number): string
  object(entries: [string, string][], level: number): string
  array(items: string[], level: number): string
  indent: string
}

const WIDTH = 72
const fits = (parts: string[], extra = 0) =>
  parts.every((p) => !p.includes('\n')) && parts.reduce((n, p) => n + p.length + 2, extra) <= WIDTH

function render(lang: Lang, v: unknown, level = 0): string {
  const r = (x: unknown, l: number) => render(lang, x, l)
  if (Array.isArray(v))
    return lang.array(
      v.map((x) => r(x, level + 1)),
      level
    )
  if (isPlainObject(v))
    return lang.object(
      Object.entries(v).map(([k, x]) => [k, r(x, level + 1)]),
      level
    )
  const s = scalar(v)
  if (!s)
    return lang.object(
      Object.entries(v as object).map(([k, x]) => [k, r(x, level + 1)]),
      level
    )
  return lang.scalar(s, r, level)
}

/** Brace-style object/array layout shared by JS, Python and mongosh. */
/** `trailing`: multi-line lists end with a comma (required by Go). */
function braces(
  open: string,
  close: string,
  parts: string[],
  level: number,
  ind: string,
  pad = true,
  trailing = false
): string {
  if (!parts.length) return open + close
  if (fits(parts, level * ind.length))
    return pad ? `${open} ${parts.join(', ')} ${close}` : `${open}${parts.join(', ')}${close}`
  const inner = ind.repeat(level + 1)
  return `${open}\n${parts.map((p) => inner + p).join(',\n')}${trailing ? ',' : ''}\n${ind.repeat(level)}${close}`
}

const JS_IDENT = /^[A-Za-z_$][\w$]*$/

// ---------------------------------------------------------------- Node.js

function nodeLang(imports: Set<string>): Lang {
  const ind = '  '
  return {
    indent: ind,
    object: (e, l) =>
      braces(
        '{',
        '}',
        e.map(([k, v]) => `${JS_IDENT.test(k) ? k : str(k)}: ${v}`),
        l,
        ind
      ),
    array: (items, l) => braces('[', ']', items, l, ind, false),
    scalar: (s, r, l) => {
      const use = (name: string) => imports.add(name)
      switch (s.kind) {
        case 'null':
          return 'null'
        case 'string':
          return str(s.v as string)
        case 'bool':
          return String(s.v)
        case 'int32':
          return String(s.v)
        case 'double': {
          const n = s.v as number
          if (Number.isInteger(n) || !Number.isFinite(n) || Object.is(n, -0)) {
            use('Double')
            return `new Double(${Object.is(n, -0) ? '-0' : String(n)})`
          }
          return String(n)
        }
        case 'int64':
          use('Long')
          return `Long.fromString(${str(s.v as string)})`
        case 'decimal':
          use('Decimal128')
          return `Decimal128.fromString(${str(s.v as string)})`
        case 'date':
          return `new Date(${str((s.v as Date).toISOString())})`
        case 'objectId':
          use('ObjectId')
          return `new ObjectId(${str(s.v as string)})`
        case 'uuid':
          use('UUID')
          return `new UUID(${str(s.v as string)})`
        case 'binary': {
          use('Binary')
          const b = s.v as { sub: number; b64: string }
          return `new Binary(Buffer.from(${str(b.b64)}, "base64"), ${b.sub})`
        }
        case 'timestamp': {
          use('Timestamp')
          const t = s.v as { t: number; i: number }
          return `new Timestamp({ t: ${t.t}, i: ${t.i} })`
        }
        case 'regex': {
          use('BSONRegExp')
          const x = s.v as { pattern: string; options: string }
          return `new BSONRegExp(${str(x.pattern)}, ${str(x.options)})`
        }
        case 'minKey':
          use('MinKey')
          return 'new MinKey()'
        case 'maxKey':
          use('MaxKey')
          return 'new MaxKey()'
        case 'symbol':
          use('BSONSymbol')
          return `new BSONSymbol(${str(s.v as string)})`
        case 'code': {
          use('Code')
          const c = s.v as { code: string; scope: Record<string, unknown> | null }
          return c.scope ? `new Code(${str(c.code)}, ${r(c.scope, l)})` : `new Code(${str(c.code)})`
        }
        case 'dbref': {
          use('DBRef')
          const d = s.v as { collection: string; oid: unknown; db?: string }
          return `new DBRef(${str(d.collection)}, ${r(d.oid, l)}${d.db ? `, ${str(d.db)}` : ''})`
        }
      }
      return 'null'
    }
  }
}

// ---------------------------------------------------------------- Python

function pyFloat(n: number): string {
  if (Number.isNaN(n)) return 'float("nan")'
  if (n === Infinity) return 'float("inf")'
  if (n === -Infinity) return 'float("-inf")'
  if (Object.is(n, -0)) return '-0.0'
  const s = String(n)
  return /[.e]/.test(s) ? s : `${s}.0`
}

function pyLang(imports: Set<string>): Lang {
  const ind = '    '
  return {
    indent: ind,
    object: (e, l) =>
      braces(
        '{',
        '}',
        e.map(([k, v]) => `${str(k)}: ${v}`),
        l,
        ind,
        false
      ),
    array: (items, l) => braces('[', ']', items, l, ind, false),
    scalar: (s, r, l) => {
      const use = (line: string) => imports.add(line)
      switch (s.kind) {
        case 'null':
          return 'None'
        case 'string':
          return str(s.v as string)
        case 'bool':
          return s.v ? 'True' : 'False'
        case 'int32':
          return String(s.v)
        case 'double':
          return pyFloat(s.v as number)
        case 'int64':
          use('from bson.int64 import Int64')
          return `Int64(${s.v as string})`
        case 'decimal':
          use('from bson.decimal128 import Decimal128')
          return `Decimal128(${str(s.v as string)})`
        case 'date': {
          const d = s.v as Date
          const y = d.getUTCFullYear()
          if (y < 1 || y > 9999) {
            use('from bson.datetime_ms import DatetimeMS')
            return `DatetimeMS(${d.getTime()})`
          }
          use('from datetime import datetime, timezone')
          const us = d.getUTCMilliseconds() * 1000
          return `datetime(${y}, ${d.getUTCMonth() + 1}, ${d.getUTCDate()}, ${d.getUTCHours()}, ${d.getUTCMinutes()}, ${d.getUTCSeconds()}${us ? `, ${us}` : ''}, tzinfo=timezone.utc)`
        }
        case 'objectId':
          use('from bson import ObjectId')
          return `ObjectId(${str(s.v as string)})`
        case 'uuid':
          use('from bson.binary import Binary')
          use('from uuid import UUID')
          return `Binary.from_uuid(UUID(${str(s.v as string)}))`
        case 'binary': {
          use('from bson.binary import Binary')
          use('import base64')
          const b = s.v as { sub: number; b64: string }
          return `Binary(base64.b64decode(${str(b.b64)}), ${b.sub})`
        }
        case 'timestamp': {
          use('from bson.timestamp import Timestamp')
          const t = s.v as { t: number; i: number }
          return `Timestamp(${t.t}, ${t.i})`
        }
        case 'regex': {
          use('from bson.regex import Regex')
          const x = s.v as { pattern: string; options: string }
          return `Regex(${str(x.pattern)}, ${str(x.options)})`
        }
        case 'minKey':
          use('from bson.min_key import MinKey')
          return 'MinKey()'
        case 'maxKey':
          use('from bson.max_key import MaxKey')
          return 'MaxKey()'
        case 'symbol':
          return str(s.v as string)
        case 'code': {
          use('from bson.code import Code')
          const c = s.v as { code: string; scope: Record<string, unknown> | null }
          return c.scope ? `Code(${str(c.code)}, ${r(c.scope, l)})` : `Code(${str(c.code)})`
        }
        case 'dbref': {
          use('from bson.dbref import DBRef')
          const d = s.v as { collection: string; oid: unknown; db?: string }
          return `DBRef(${str(d.collection)}, ${r(d.oid, l)}${d.db ? `, ${str(d.db)}` : ''})`
        }
      }
      return 'None'
    }
  }
}

// ---------------------------------------------------------------- Java

function javaDouble(n: number): string {
  if (Number.isNaN(n)) return 'Double.NaN'
  if (n === Infinity) return 'Double.POSITIVE_INFINITY'
  if (n === -Infinity) return 'Double.NEGATIVE_INFINITY'
  if (Object.is(n, -0)) return '-0.0'
  const s = String(n)
  return /[.e]/.test(s) ? s : `${s}.0`
}

function javaLang(imports: Set<string>): Lang {
  const ind = '    '
  return {
    indent: ind,
    object: (e, l) => {
      imports.add('org.bson.Document')
      if (!e.length) return 'new Document()'
      const [first, ...rest] = e
      const head = `new Document(${str(first![0])}, ${first![1]})`
      const parts = rest.map(([k, v]) => `.append(${str(k)}, ${v})`)
      if (fits([head, ...parts], l * ind.length)) return head + parts.join('')
      const inner = ind.repeat(l + 2)
      return head + parts.map((p) => `\n${inner}${p}`).join('')
    },
    array: (items, l) => {
      imports.add('java.util.Arrays')
      return braces('Arrays.asList(', ')', items, l, ind, false)
    },
    scalar: (s, r, l) => {
      const use = (name: string) => imports.add(name)
      switch (s.kind) {
        case 'null':
          return 'null'
        case 'string':
          return str(s.v as string)
        case 'bool':
          return String(s.v)
        case 'int32':
          return String(s.v)
        case 'double':
          return javaDouble(s.v as number)
        case 'int64':
          return `${s.v as string}L`
        case 'decimal':
          use('org.bson.types.Decimal128')
          return `Decimal128.parse(${str(s.v as string)})`
        case 'date':
          use('java.util.Date')
          use('java.time.Instant')
          return `Date.from(Instant.parse(${str((s.v as Date).toISOString())}))`
        case 'objectId':
          use('org.bson.types.ObjectId')
          return `new ObjectId(${str(s.v as string)})`
        case 'uuid':
          use('org.bson.BsonBinary')
          use('java.util.UUID')
          return `new BsonBinary(UUID.fromString(${str(s.v as string)}))`
        case 'binary': {
          use('org.bson.types.Binary')
          use('java.util.Base64')
          const b = s.v as { sub: number; b64: string }
          return `new Binary((byte) ${b.sub}, Base64.getDecoder().decode(${str(b.b64)}))`
        }
        case 'timestamp': {
          use('org.bson.BsonTimestamp')
          const t = s.v as { t: number; i: number }
          return `new BsonTimestamp(${t.t}, ${t.i})`
        }
        case 'regex': {
          use('org.bson.BsonRegularExpression')
          const x = s.v as { pattern: string; options: string }
          return `new BsonRegularExpression(${str(x.pattern)}, ${str(x.options)})`
        }
        case 'minKey':
          use('org.bson.types.MinKey')
          return 'new MinKey()'
        case 'maxKey':
          use('org.bson.types.MaxKey')
          return 'new MaxKey()'
        case 'symbol':
          use('org.bson.types.Symbol')
          return `new Symbol(${str(s.v as string)})`
        case 'code': {
          const c = s.v as { code: string; scope: Record<string, unknown> | null }
          if (c.scope) {
            use('org.bson.types.CodeWithScope')
            return `new CodeWithScope(${str(c.code)}, ${r(c.scope, l)})`
          }
          use('org.bson.types.Code')
          return `new Code(${str(c.code)})`
        }
        case 'dbref': {
          use('com.mongodb.DBRef')
          const d = s.v as { collection: string; oid: unknown; db?: string }
          return d.db
            ? `new DBRef(${str(d.db)}, ${str(d.collection)}, ${r(d.oid, l)})`
            : `new DBRef(${str(d.collection)}, ${r(d.oid, l)})`
        }
      }
      return 'null'
    }
  }
}

// ---------------------------------------------------------------- C#

function csDouble(n: number): string {
  if (Number.isNaN(n)) return 'double.NaN'
  if (n === Infinity) return 'double.PositiveInfinity'
  if (n === -Infinity) return 'double.NegativeInfinity'
  if (Object.is(n, -0)) return '-0.0'
  const s = String(n)
  return /[.e]/.test(s) ? s : `${s}.0`
}

function csLang(): Lang {
  const ind = '    '
  return {
    indent: ind,
    object: (e, l) => {
      if (!e.length) return 'new BsonDocument()'
      return braces(
        'new BsonDocument {',
        '}',
        e.map(([k, v]) => `{ ${str(k)}, ${v} }`),
        l,
        ind
      )
    },
    array: (items, l) => (items.length ? braces('new BsonArray {', '}', items, l, ind) : 'new BsonArray()'),
    scalar: (s, r, l) => {
      switch (s.kind) {
        case 'null':
          return 'BsonNull.Value'
        case 'string':
          return str(s.v as string)
        case 'bool':
          return s.v ? 'true' : 'false'
        case 'int32':
          return String(s.v)
        case 'double':
          return csDouble(s.v as number)
        case 'int64':
          return `${s.v as string}L`
        case 'decimal':
          return `new BsonDecimal128(Decimal128.Parse(${str(s.v as string)}))`
        case 'date':
          return `new BsonDateTime(${(s.v as Date).getTime()}) /* ${(s.v as Date).toISOString()} */`
        case 'objectId':
          return `ObjectId.Parse(${str(s.v as string)})`
        case 'uuid':
          return `new BsonBinaryData(Guid.Parse(${str(s.v as string)}), GuidRepresentation.Standard)`
        case 'binary': {
          const b = s.v as { sub: number; b64: string }
          return `new BsonBinaryData(Convert.FromBase64String(${str(b.b64)}), (BsonBinarySubType)${b.sub})`
        }
        case 'timestamp': {
          const t = s.v as { t: number; i: number }
          return `new BsonTimestamp(${t.t}, ${t.i})`
        }
        case 'regex': {
          const x = s.v as { pattern: string; options: string }
          return `new BsonRegularExpression(${str(x.pattern)}, ${str(x.options)})`
        }
        case 'minKey':
          return 'BsonMinKey.Value'
        case 'maxKey':
          return 'BsonMaxKey.Value'
        case 'symbol':
          return `BsonSymbolTable.Lookup(${str(s.v as string)})`
        case 'code': {
          const c = s.v as { code: string; scope: Record<string, unknown> | null }
          return c.scope
            ? `new BsonJavaScriptWithScope(${str(c.code)}, ${r(c.scope, l)})`
            : `new BsonJavaScript(${str(c.code)})`
        }
        case 'dbref': {
          const d = s.v as { collection: string; oid: unknown; db?: string }
          const entries: [string, string][] = [
            ['$ref', str(d.collection)],
            ['$id', r(d.oid, l + 1)]
          ]
          if (d.db) entries.push(['$db', str(d.db)])
          return braces(
            'new BsonDocument {',
            '}',
            entries.map(([k, v]) => `{ ${str(k)}, ${v} }`),
            l,
            ind
          )
        }
      }
      return 'BsonNull.Value'
    }
  }
}

// ---------------------------------------------------------------- Go (driver v2)

function goFloat(n: number, imports: Set<string>): string {
  if (Number.isNaN(n)) {
    imports.add('math')
    return 'math.NaN()'
  }
  if (n === Infinity || n === -Infinity) {
    imports.add('math')
    return `math.Inf(${n > 0 ? 1 : -1})`
  }
  if (Object.is(n, -0)) {
    imports.add('math')
    return 'math.Copysign(0, -1)'
  }
  return `float64(${n})`
}

const GO_HELPERS: Record<string, string> = {
  oid: `func oid(hex string) bson.ObjectID {
	id, err := bson.ObjectIDFromHex(hex)
	if err != nil {
		panic(err)
	}
	return id
}`,
  dec: `func dec(s string) bson.Decimal128 {
	d, err := bson.ParseDecimal128(s)
	if err != nil {
		panic(err)
	}
	return d
}`,
  b64: `func b64(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}`
}

function goLang(imports: Set<string>, helpers: Set<string>): Lang {
  const ind = '\t'
  return {
    indent: ind,
    object: (e, l) =>
      braces(
        'bson.D{',
        '}',
        e.map(([k, v]) => `{Key: ${str(k)}, Value: ${v}}`),
        l,
        ind,
        false,
        true
      ),
    array: (items, l) => braces('bson.A{', '}', items, l, ind, false, true),
    scalar: (s, r, l) => {
      switch (s.kind) {
        case 'null':
          return 'nil'
        case 'string':
          return str(s.v as string)
        case 'bool':
          return String(s.v)
        case 'int32':
          return `int32(${s.v as number})`
        case 'double':
          return goFloat(s.v as number, imports)
        case 'int64':
          return `int64(${s.v as string})`
        case 'decimal':
          helpers.add('dec')
          return `dec(${str(s.v as string)})`
        case 'date':
          return `bson.DateTime(${(s.v as Date).getTime()}) /* ${(s.v as Date).toISOString()} */`
        case 'objectId':
          helpers.add('oid')
          return `oid(${str(s.v as string)})`
        case 'uuid': {
          helpers.add('b64')
          imports.add('encoding/base64')
          const hex = (s.v as string).replace(/-/g, '')
          const bytes = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
          return `bson.Binary{Subtype: 0x04, Data: b64(${str(base64Of(bytes))})} /* UUID ${s.v as string} */`
        }
        case 'binary': {
          helpers.add('b64')
          imports.add('encoding/base64')
          const b = s.v as { sub: number; b64: string }
          return `bson.Binary{Subtype: 0x${b.sub.toString(16).padStart(2, '0')}, Data: b64(${str(b.b64)})}`
        }
        case 'timestamp': {
          const t = s.v as { t: number; i: number }
          return `bson.Timestamp{T: ${t.t}, I: ${t.i}}`
        }
        case 'regex': {
          const x = s.v as { pattern: string; options: string }
          return `bson.Regex{Pattern: ${str(x.pattern)}, Options: ${str(x.options)}}`
        }
        case 'minKey':
          return 'bson.MinKey{}'
        case 'maxKey':
          return 'bson.MaxKey{}'
        case 'symbol':
          return `bson.Symbol(${str(s.v as string)})`
        case 'code': {
          const c = s.v as { code: string; scope: Record<string, unknown> | null }
          return c.scope
            ? `bson.CodeWithScope{Code: bson.JavaScript(${str(c.code)}), Scope: ${r(c.scope, l)}}`
            : `bson.JavaScript(${str(c.code)})`
        }
        case 'dbref': {
          const d = s.v as { collection: string; oid: unknown; db?: string }
          const e: [string, string][] = [
            ['$ref', str(d.collection)],
            ['$id', r(d.oid, l + 1)]
          ]
          if (d.db) e.push(['$db', str(d.db)])
          return braces(
            'bson.D{',
            '}',
            e.map(([k, v]) => `{Key: ${str(k)}, Value: ${v}}`),
            l,
            ind,
            false,
            true
          )
        }
      }
      return 'nil'
    }
  }
}

// ---------------------------------------------------------------- programs

const sortDoc = (s: ExportableQuery['sort']): Record<string, unknown> | undefined =>
  Array.isArray(s) ? Object.fromEntries(s) : s

const has = (v: unknown) => v !== undefined && !(isPlainObject(v) && !Object.keys(v).length)

function indentBlock(code: string, prefix: string): string {
  return code
    .split('\n')
    .map((l, i) => (i ? prefix + l : l))
    .join('\n')
}

function nodeProgram(t: ExportTarget, q: ExportableQuery, mode: ExportMode): string {
  const imports = new Set<string>()
  const lang = nodeLang(imports)
  const v = (x: unknown, level = 1) => render(lang, x, level)
  const opts: string[] = []
  if (mode === 'find') {
    if (has(q.project)) opts.push(`projection: ${v(q.project, 2)}`)
    if (has(q.sort)) opts.push(`sort: ${v(sortDoc(q.sort), 2)}`)
  }
  if (q.skip) opts.push(`skip: ${q.skip}`)
  if (q.limit) opts.push(`limit: ${q.limit}`)
  if (has(q.collation)) opts.push(`collation: ${v(q.collation, 2)}`)
  if (q.hint !== undefined) opts.push(`hint: ${typeof q.hint === 'string' ? str(q.hint) : v(q.hint, 2)}`)
  if (q.maxTimeMS) opts.push(`maxTimeMS: ${q.maxTimeMS}`)
  const filter = v(q.filter)
  const optText = opts.length ? `, {\n    ${opts.join(',\n    ')}\n  }` : ''
  const body =
    mode === 'find'
      ? `  const cursor = coll.find(filter${optText})\n  for await (const doc of cursor) console.log(doc)`
      : `  const count = await coll.countDocuments(filter${optText})\n  console.log(count)`
  const names = ['MongoClient', ...[...imports].sort()]
  return `// Set MONGODB_URI to your connection string.
import { ${names.join(', ')} } from "mongodb"

const client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://localhost:27017")

try {
  const coll = client.db(${str(t.db)}).collection(${str(t.collection)})
  const filter = ${filter}
${body}
} finally {
  await client.close()
}
`
}

function pyPairs(doc: Record<string, unknown>, lang: Lang): string {
  return `[${Object.entries(doc)
    .map(([k, d]) => `(${str(k)}, ${render(lang, d, 2)})`)
    .join(', ')}]`
}

function pythonProgram(t: ExportTarget, q: ExportableQuery, mode: ExportMode): string {
  const imports = new Set<string>()
  const lang = pyLang(imports)
  const v = (x: unknown, level = 1) => render(lang, x, level)
  const args: string[] = ['query']
  if (mode === 'find') {
    if (has(q.project)) args.push(`projection=${v(q.project, 2)}`)
    if (has(q.sort)) args.push(`sort=${pyPairs(sortDoc(q.sort)!, lang)}`)
  }
  if (q.skip) args.push(`skip=${q.skip}`)
  if (q.limit) args.push(`limit=${q.limit}`)
  if (has(q.collation)) args.push(`collation=${v(q.collation, 2)}`)
  if (q.hint !== undefined)
    args.push(`hint=${typeof q.hint === 'string' ? str(q.hint) : pyPairs(q.hint, lang)}`)
  if (q.maxTimeMS) args.push(mode === 'find' ? `max_time_ms=${q.maxTimeMS}` : `maxTimeMS=${q.maxTimeMS}`)
  const call = args.length > 1 ? `(\n        ${args.join(',\n        ')},\n    )` : '(query)'
  const query = v(q.filter)
  const body =
    mode === 'find'
      ? `    for doc in coll.find${call}:\n        print(doc)`
      : `    print(coll.count_documents${call})`
  const importLines = ['import os', 'from pymongo import MongoClient', ...[...imports].sort()]
  return `# Set MONGODB_URI to your connection string.
${importLines.join('\n')}

client = MongoClient(os.environ.get("MONGODB_URI", "mongodb://localhost:27017"))
try:
    coll = client[${str(t.db)}][${str(t.collection)}]
    query = ${query}
${body}
finally:
    client.close()
`
}

const JAVA_COLLATION: Record<string, (v: unknown) => string> = {
  locale: (v) => `.locale(${str(String(v))})`,
  caseLevel: (v) => `.caseLevel(${Boolean(v)})`,
  caseFirst: (v) => `.collationCaseFirst(CollationCaseFirst.fromString(${str(String(v))}))`,
  strength: (v) => `.collationStrength(CollationStrength.fromInt(${Number(numeric(v))}))`,
  numericOrdering: (v) => `.numericOrdering(${Boolean(v)})`,
  alternate: (v) => `.collationAlternate(CollationAlternate.fromString(${str(String(v))}))`,
  maxVariable: (v) => `.collationMaxVariable(CollationMaxVariable.fromString(${str(String(v))}))`,
  normalization: (v) => `.normalization(${Boolean(v)})`,
  backwards: (v) => `.backwards(${Boolean(v)})`
}

function numeric(v: unknown): number {
  if (typeof v === 'number') return v
  const s = scalar(v)
  return s && (s.kind === 'int32' || s.kind === 'double') ? (s.v as number) : Number(String(v))
}

function javaProgram(t: ExportTarget, q: ExportableQuery, mode: ExportMode): string {
  const imports = new Set<string>([
    'com.mongodb.client.MongoClient',
    'com.mongodb.client.MongoClients',
    'com.mongodb.client.MongoCollection',
    'org.bson.Document'
  ])
  const lang = javaLang(imports)
  const v = (x: unknown, level = 3) => render(lang, x, level)
  const chain: string[] = []
  let collation = ''
  if (has(q.collation)) {
    imports.add('com.mongodb.client.model.Collation')
    const parts = Object.entries(q.collation!).map(([k, x]) => {
      const f = JAVA_COLLATION[k]
      if (!f) return `/* unsupported collation option ${k} */`
      if (k === 'caseFirst') imports.add('com.mongodb.client.model.CollationCaseFirst')
      if (k === 'strength') imports.add('com.mongodb.client.model.CollationStrength')
      if (k === 'alternate') imports.add('com.mongodb.client.model.CollationAlternate')
      if (k === 'maxVariable') imports.add('com.mongodb.client.model.CollationMaxVariable')
      return f(x)
    })
    collation = `Collation.builder()${parts.join('')}.build()`
  }
  const hint = q.hint === undefined ? null : typeof q.hint === 'string' ? q.hint : v(q.hint)
  const filter = v(q.filter)
  let body: string
  if (mode === 'find') {
    imports.add('com.mongodb.client.FindIterable')
    if (has(q.project)) chain.push(`.projection(${v(q.project)})`)
    if (has(q.sort)) chain.push(`.sort(${v(sortDoc(q.sort))})`)
    if (q.skip) chain.push(`.skip(${q.skip})`)
    if (q.limit) chain.push(`.limit(${q.limit})`)
    if (collation) chain.push(`.collation(${collation})`)
    if (hint !== null) chain.push(typeof q.hint === 'string' ? `.hintString(${str(hint)})` : `.hint(${hint})`)
    if (q.maxTimeMS) {
      imports.add('java.util.concurrent.TimeUnit')
      chain.push(`.maxTime(${q.maxTimeMS}, TimeUnit.MILLISECONDS)`)
    }
    body = `            FindIterable<Document> result = coll.find(filter)${chain.map((c) => `\n                    ${c}`).join('')};
            for (Document doc : result) {
                System.out.println(doc.toJson());
            }`
  } else {
    imports.add('com.mongodb.client.model.CountOptions')
    const o: string[] = []
    if (q.skip) o.push(`.skip(${q.skip})`)
    if (q.limit) o.push(`.limit(${q.limit})`)
    if (collation) o.push(`.collation(${collation})`)
    if (hint !== null) o.push(typeof q.hint === 'string' ? `.hintString(${str(hint)})` : `.hint(${hint})`)
    if (q.maxTimeMS) {
      imports.add('java.util.concurrent.TimeUnit')
      o.push(`.maxTime(${q.maxTimeMS}, TimeUnit.MILLISECONDS)`)
    }
    body = `            long count = coll.countDocuments(filter${o.length ? `, new CountOptions()${o.map((c) => `\n                    ${c}`).join('')}` : ''});
            System.out.println(count);`
  }
  return `// Set MONGODB_URI to your connection string.
${[...imports]
  .sort()
  .map((i) => `import ${i};`)
  .join('\n')}

public class Query {
    public static void main(String[] args) {
        String uri = System.getenv().getOrDefault("MONGODB_URI", "mongodb://localhost:27017");
        try (MongoClient client = MongoClients.create(uri)) {
            MongoCollection<Document> coll = client.getDatabase(${str(t.db)}).getCollection(${str(t.collection)});
            Document filter = ${indentBlock(filter, '')};
${body}
        }
    }
}
`
}

function csharpProgram(t: ExportTarget, q: ExportableQuery, mode: ExportMode): string {
  const lang = csLang()
  const v = (x: unknown, level = 0) => render(lang, x, level)
  const opts: string[] = []
  if (has(q.collation)) opts.push(`Collation = Collation.FromBsonDocument(${v(q.collation, 1)})`)
  if (q.hint !== undefined) opts.push(`Hint = ${typeof q.hint === 'string' ? str(q.hint) : v(q.hint, 1)}`)
  if (q.maxTimeMS) opts.push(`MaxTime = TimeSpan.FromMilliseconds(${q.maxTimeMS})`)
  if (mode === 'count') {
    if (q.skip) opts.push(`Skip = ${q.skip}`)
    if (q.limit) opts.push(`Limit = ${q.limit}`)
  }
  const optType = mode === 'find' ? 'FindOptions' : 'CountOptions'
  const optText = opts.length ? `new ${optType}\n{\n    ${opts.join(',\n    ')}\n}` : ''
  let body: string
  if (mode === 'find') {
    const chain: string[] = []
    if (has(q.project)) chain.push(`.Project(${v(q.project, 1)})`)
    if (has(q.sort)) chain.push(`.Sort(${v(sortDoc(q.sort), 1)})`)
    if (q.skip) chain.push(`.Skip(${q.skip})`)
    if (q.limit) chain.push(`.Limit(${q.limit})`)
    body = `${optText ? `var options = ${optText};\n` : ''}var docs = coll.Find(filter${optText ? ', options' : ''})${chain.map((c) => `\n    ${c}`).join('')}
    .ToList();
foreach (var doc in docs)
{
    Console.WriteLine(doc);
}`
  } else {
    body = `${optText ? `var options = ${optText};\n` : ''}var count = coll.CountDocuments(filter${optText ? ', options' : ''});
Console.WriteLine(count);`
  }
  return `// Set MONGODB_URI to your connection string.
using MongoDB.Bson;
using MongoDB.Driver;

var uri = Environment.GetEnvironmentVariable("MONGODB_URI") ?? "mongodb://localhost:27017";
var client = new MongoClient(uri);
var coll = client.GetDatabase(${str(t.db)}).GetCollection<BsonDocument>(${str(t.collection)});
var filter = ${v(q.filter)};
${body}
`
}

const GO_COLLATION: Record<string, (v: unknown) => string> = {
  locale: (v) => `Locale: ${str(String(v))}`,
  caseLevel: (v) => `CaseLevel: ${Boolean(v)}`,
  caseFirst: (v) => `CaseFirst: ${str(String(v))}`,
  strength: (v) => `Strength: ${numeric(v)}`,
  numericOrdering: (v) => `NumericOrdering: ${Boolean(v)}`,
  alternate: (v) => `Alternate: ${str(String(v))}`,
  maxVariable: (v) => `MaxVariable: ${str(String(v))}`,
  normalization: (v) => `Normalization: ${Boolean(v)}`,
  backwards: (v) => `Backwards: ${Boolean(v)}`
}

function goProgram(t: ExportTarget, q: ExportableQuery, mode: ExportMode): string {
  const imports = new Set<string>(['context', 'fmt', 'os'])
  const helpers = new Set<string>()
  const lang = goLang(imports, helpers)
  const v = (x: unknown, level = 1) => render(lang, x, level)
  const setters: string[] = []
  if (mode === 'find') {
    if (has(q.project)) setters.push(`SetProjection(${v(q.project, 2)})`)
    if (has(q.sort)) setters.push(`SetSort(${v(sortDoc(q.sort), 2)})`)
  }
  if (q.skip) setters.push(`SetSkip(${q.skip})`)
  if (q.limit) setters.push(`SetLimit(${q.limit})`)
  if (has(q.collation))
    setters.push(
      `SetCollation(&options.Collation{${Object.entries(q.collation!)
        .map(([k, x]) => GO_COLLATION[k]?.(x) ?? `/* unsupported: ${k} */`)
        .join(', ')}})`
    )
  if (q.hint !== undefined)
    setters.push(`SetHint(${typeof q.hint === 'string' ? str(q.hint) : v(q.hint, 2)})`)
  let ctx = '\tctx := context.Background()'
  if (q.maxTimeMS) {
    imports.add('time')
    // Driver v2 removed per-operation maxTimeMS; a context deadline is the replacement.
    ctx = `\tctx, cancel := context.WithTimeout(context.Background(), ${q.maxTimeMS}*time.Millisecond)\n\tdefer cancel()`
  }
  const optsVar = setters.length
    ? `\topts := options.${mode === 'find' ? 'Find' : 'Count'}()${setters.map((s) => `.\n\t\t${s}`).join('')}\n`
    : ''
  const filter = v(q.filter)
  const body =
    mode === 'find'
      ? `${optsVar}\tcursor, err := coll.Find(ctx, filter${setters.length ? ', opts' : ''})
	if err != nil {
		panic(err)
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		fmt.Println(cursor.Current)
	}
	if err := cursor.Err(); err != nil {
		panic(err)
	}`
      : `${optsVar}\tcount, err := coll.CountDocuments(ctx, filter${setters.length ? ', opts' : ''})
	if err != nil {
		panic(err)
	}
	fmt.Println(count)`
  const std = [...imports].sort()
  const driver = [
    'go.mongodb.org/mongo-driver/v2/bson',
    'go.mongodb.org/mongo-driver/v2/mongo',
    'go.mongodb.org/mongo-driver/v2/mongo/options'
  ]
  return `// Set MONGODB_URI to your connection string.
package main

import (
${std.map((i) => `\t${str(i)}`).join('\n')}

${driver.map((i) => `\t${str(i)}`).join('\n')}
)

func main() {
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://localhost:27017"
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		panic(err)
	}
	defer client.Disconnect(context.Background())

${ctx}
	coll := client.Database(${str(t.db)}).Collection(${str(t.collection)})
	filter := ${filter}
${body}
}
${[...helpers].map((h) => `\n${GO_HELPERS[h]}\n`).join('')}`
}

function shellProgram(t: ExportTarget, q: ExportableQuery, mode: ExportMode): string {
  const v = (x: unknown) => {
    const oneLine = toShellString(x, 0)
    return oneLine.length <= 60 ? oneLine : toShellString(x, 2, 0)
  }
  const coll = JS_IDENT.test(t.collection)
    ? `db.getSiblingDB(${str(t.db)}).${t.collection}`
    : `db.getSiblingDB(${str(t.db)}).getCollection(${str(t.collection)})`
  if (mode === 'count') {
    const o: Record<string, unknown> = {}
    if (q.skip) o.skip = q.skip
    if (q.limit) o.limit = q.limit
    if (has(q.collation)) o.collation = q.collation
    if (q.hint !== undefined) o.hint = q.hint
    if (q.maxTimeMS) o.maxTimeMS = q.maxTimeMS
    return `${coll}.countDocuments(${v(q.filter)}${Object.keys(o).length ? `, ${v(o)}` : ''})\n`
  }
  const chain: string[] = []
  if (has(q.sort)) chain.push(`.sort(${v(sortDoc(q.sort))})`)
  if (q.skip) chain.push(`.skip(${q.skip})`)
  if (q.limit) chain.push(`.limit(${q.limit})`)
  if (has(q.collation)) chain.push(`.collation(${v(q.collation)})`)
  if (q.hint !== undefined) chain.push(`.hint(${typeof q.hint === 'string' ? str(q.hint) : v(q.hint)})`)
  if (q.maxTimeMS) chain.push(`.maxTimeMS(${q.maxTimeMS})`)
  return `${coll}.find(${v(q.filter)}${has(q.project) ? `, ${v(q.project)}` : ''})${chain.map((c) => `\n  ${c}`).join('')}\n`
}

export function exportQuery(
  language: ExportLanguage,
  target: ExportTarget,
  query: ExportableQuery,
  mode: ExportMode = 'find'
): string {
  switch (language) {
    case 'node':
      return nodeProgram(target, query, mode)
    case 'python':
      return pythonProgram(target, query, mode)
    case 'java':
      return javaProgram(target, query, mode)
    case 'csharp':
      return csharpProgram(target, query, mode)
    case 'go':
      return goProgram(target, query, mode)
    case 'shell':
      return shellProgram(target, query, mode)
  }
}

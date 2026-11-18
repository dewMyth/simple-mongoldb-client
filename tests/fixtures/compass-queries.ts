/**
 * Compass query-bar compatibility corpus: the contract for what the query bar accepts.
 *
 * Each entry is the exact text a user would type and the canonical EJSON it must produce.
 * Expected values are written by hand (dates computed independently with Date.parse), so a
 * parser upgrade that changes behaviour fails loudly.
 *
 * `field` defaults to 'filter'. Entries with `error` must be rejected (and never executed).
 */

type Canonical = unknown

export interface CorpusEntry {
  name: string
  field?: 'filter' | 'project' | 'sort' | 'collation'
  input: string
  expected?: Canonical
  /** Substring (or regex) expected in the error message. */
  error?: string | RegExp
}

// Canonical EJSON shorthands, purely to keep the table readable.
const i = (n: number) => ({ $numberInt: String(n) })
const l = (n: string) => ({ $numberLong: n })
const dbl = (n: string) => ({ $numberDouble: n })
const dec = (n: string) => ({ $numberDecimal: n })
const date = (ms: number) => ({ $date: { $numberLong: String(ms) } })
const oid = (h: string) => ({ $oid: h })
const re = (pattern: string, options = '') => ({ $regularExpression: { pattern, options } })
const bin = (base64: string, subType: string) => ({ $binary: { base64, subType } })

const OID = '65f1c0a1b2c3d4e5f6a7b8c9'
const UUID_B64 = 'OyQRAeK7QlWMr0E2xWapYg=='

export const compassQueries: CorpusEntry[] = [
  // ------------------------------------------------------------------ the examples from the plan
  { name: 'ObjectId', input: `{ _id: ObjectId("${OID}") }`, expected: { _id: oid(OID) } },
  {
    name: 'ISODate in $gte',
    input: '{ createdAt: { $gte: ISODate("2026-01-01") } }',
    expected: { createdAt: { $gte: date(1767225600000) } }
  },
  { name: 'regex literal with flag', input: '{ name: /^dew/i }', expected: { name: re('^dew', 'i') } },
  {
    name: 'numeric constructors',
    input: '{ amount: NumberDecimal("10.50"), qty: NumberLong(5), n: NumberInt(3) }',
    expected: { amount: dec('10.50'), qty: l('5'), n: i(3) }
  },
  {
    name: 'UUID and BinData',
    input: '{ uuid: UUID("3b241101-e2bb-4255-8caf-4136c566a962"), bin: BinData(0, "AAEC") }',
    expected: { uuid: bin(UUID_B64, '04'), bin: bin('AAEC', '00') }
  },
  {
    name: 'Timestamp object form',
    input: '{ ts: Timestamp({ t: 1700000000, i: 1 }) }',
    expected: { ts: { $timestamp: { t: 1700000000, i: 1 } } }
  },
  {
    name: '$expr',
    input: '{ $expr: { $gt: ["$a", "$b"] } }',
    expected: { $expr: { $gt: ['$a', '$b'] } }
  },
  {
    name: '$elemMatch',
    input: '{ tags: { $elemMatch: { $eq: "x" } } }',
    expected: { tags: { $elemMatch: { $eq: 'x' } } }
  },
  {
    name: '$near with $geometry',
    input: '{ loc: { $near: { $geometry: { type: "Point", coordinates: [79.86, 6.92] } } } }',
    expected: {
      loc: { $near: { $geometry: { type: 'Point', coordinates: [dbl('79.86'), dbl('6.92')] } } }
    }
  },
  { name: '$text', input: '{ $text: { $search: "coffee" } }', expected: { $text: { $search: 'coffee' } } },
  {
    name: 'dotted path, single quotes, unquoted key',
    input: `{ "nested.field": { $exists: true }, 'single': 'quotes', unquoted: 1 }`,
    expected: { 'nested.field': { $exists: true }, single: 'quotes', unquoted: i(1) }
  },

  // ------------------------------------------------------------------ empty / trivial
  { name: 'empty string means match all', input: '', expected: {} },
  { name: 'whitespace only', input: '   \n  ', expected: {} },
  { name: 'empty object', input: '{}', expected: {} },
  { name: 'strict JSON', input: '{"a": 1, "b": "x"}', expected: { a: i(1), b: 'x' } },

  // ------------------------------------------------------------------ syntax leniency
  { name: 'trailing comma', input: '{ a: 1, }', expected: { a: i(1) } },
  {
    name: 'trailing comma in array',
    input: '{ a: { $in: [1, 2,] } }',
    expected: { a: { $in: [i(1), i(2)] } }
  },
  { name: 'line comment', input: '{ a: 1 } // only active', expected: { a: i(1) } },
  { name: 'block comment', input: '{ /* status */ status: "active" }', expected: { status: 'active' } },
  { name: 'multi-line input', input: '{\n  a: 1,\n  b: 2\n}', expected: { a: i(1), b: i(2) } },
  { name: 'quoted $ operator key', input: '{ "a": { "$gt": 5 } }', expected: { a: { $gt: i(5) } } },
  { name: 'unicode escape', input: '{ name: "\\u00e9t\\u00e9" }', expected: { name: 'été' } },
  { name: 'unicode literal', input: '{ city: "Colombo 🇱🇰" }', expected: { city: 'Colombo 🇱🇰' } },
  { name: 'key with spaces', input: '{ "first name": "Ann" }', expected: { 'first name': 'Ann' } },
  { name: 'numeric-looking key', input: '{ "0": "zero" }', expected: { '0': 'zero' } },
  { name: 'deep dotted array index', input: '{ "items.0.sku": "A1" }', expected: { 'items.0.sku': 'A1' } },

  // ------------------------------------------------------------------ number semantics (JS, like Compass)
  { name: 'integer is Int32', input: '{ a: 5 }', expected: { a: i(5) } },
  { name: '1.0 is Int32 (JS has no 1.0)', input: '{ a: 1.0 }', expected: { a: i(1) } },
  { name: 'fraction is Double', input: '{ a: 1.5 }', expected: { a: dbl('1.5') } },
  { name: 'beyond int32 is Int64', input: '{ a: 3000000000 }', expected: { a: l('3000000000') } },
  { name: 'negative integer', input: '{ a: -42 }', expected: { a: i(-42) } },
  { name: 'negative zero is Double', input: '{ a: -0 }', expected: { a: dbl('-0.0') } },
  { name: 'exponent integer', input: '{ a: 1e3 }', expected: { a: i(1000) } },
  { name: 'exponent fraction', input: '{ a: 1.5e-3 }', expected: { a: dbl('0.0015') } },
  { name: 'hex literal', input: '{ a: 0x10 }', expected: { a: i(16) } },
  { name: 'NaN', input: '{ a: NaN }', expected: { a: dbl('NaN') } },
  { name: 'Infinity', input: '{ a: Infinity }', expected: { a: dbl('Infinity') } },
  { name: '-Infinity', input: '{ a: -Infinity }', expected: { a: dbl('-Infinity') } },
  { name: 'arithmetic is folded', input: '{ a: 1 + 2 }', expected: { a: i(3) } },

  // ------------------------------------------------------------------ BSON constructors
  { name: 'ObjectID alias', input: `{ _id: ObjectID("${OID}") }`, expected: { _id: oid(OID) } },
  { name: 'new ObjectId', input: `{ _id: new ObjectId("${OID}") }`, expected: { _id: oid(OID) } },
  { name: 'ObjectId single quotes', input: `{ _id: ObjectId('${OID}') }`, expected: { _id: oid(OID) } },
  {
    name: 'ISODate with time and Z',
    input: '{ d: ISODate("2026-01-01T00:00:00Z") }',
    expected: { d: date(1767225600000) }
  },
  {
    name: 'ISODate with milliseconds',
    input: '{ d: ISODate("2025-06-15T08:30:00.500Z") }',
    expected: { d: date(1749976200500) }
  },
  {
    name: 'ISODate with offset',
    input: '{ d: ISODate("2026-01-01T10:00:00+05:30") }',
    expected: { d: date(1767241800000) }
  },
  {
    name: 'ISODate before 1970',
    input: '{ d: ISODate("1969-07-20T20:17:40Z") }',
    expected: { d: date(-14182940000) }
  },
  {
    name: 'ISODate leap day',
    input: '{ d: ISODate("2000-02-29T00:00:00Z") }',
    expected: { d: date(951782400000) }
  },
  { name: 'new ISODate', input: '{ d: new ISODate("2026-01-01") }', expected: { d: date(1767225600000) } },
  {
    name: 'new Date(string)',
    input: '{ d: new Date("2024-12-31T23:59:59.999Z") }',
    expected: { d: date(1735689599999) }
  },
  { name: 'new Date(millis)', input: '{ d: new Date(0) }', expected: { d: date(0) } },
  {
    name: 'NumberLong from string keeps precision',
    input: '{ n: NumberLong("9007199254740993") }',
    expected: { n: l('9007199254740993') }
  },
  { name: 'NumberLong negative string', input: '{ n: NumberLong("-5") }', expected: { n: l('-5') } },
  { name: 'Long alias', input: '{ n: Long(5) }', expected: { n: l('5') } },
  { name: 'NumberInt from string', input: '{ n: NumberInt("42") }', expected: { n: i(42) } },
  { name: 'Int32 alias', input: '{ n: Int32(5) }', expected: { n: i(5) } },
  { name: 'Double keeps whole numbers as Double', input: '{ n: Double(5) }', expected: { n: dbl('5.0') } },
  { name: 'Double fraction', input: '{ n: Double(1.5) }', expected: { n: dbl('1.5') } },
  {
    name: 'NumberDecimal many digits',
    input: '{ n: NumberDecimal("1234567890.123456789012345") }',
    expected: { n: dec('1234567890.123456789012345') }
  },
  { name: 'Decimal128 alias', input: '{ n: Decimal128("1.5") }', expected: { n: dec('1.5') } },
  {
    name: 'BinData subtype 4',
    input: `{ b: BinData(4, "${UUID_B64}") }`,
    expected: { b: bin(UUID_B64, '04') }
  },
  {
    name: 'BinData subtype 5 (MD5)',
    input: '{ b: BinData(5, "1B2M2Y8AsgTpgAmY7PhCfg==") }',
    expected: { b: bin('1B2M2Y8AsgTpgAmY7PhCfg==', '05') }
  },
  {
    name: 'Timestamp positional',
    input: '{ ts: Timestamp(1700000000, 1) }',
    expected: { ts: { $timestamp: { t: 1700000000, i: 1 } } }
  },
  { name: 'MinKey', input: '{ k: MinKey() }', expected: { k: { $minKey: 1 } } },
  { name: 'MaxKey', input: '{ k: MaxKey() }', expected: { k: { $maxKey: 1 } } },
  {
    name: 'DBRef',
    input: `{ ref: DBRef("orders", ObjectId("${OID}")) }`,
    expected: { ref: { $ref: 'orders', $id: oid(OID) } }
  },
  {
    name: 'DBRef with db',
    input: `{ ref: DBRef("orders", ObjectId("${OID}"), "shop") }`,
    expected: { ref: { $ref: 'orders', $id: oid(OID), $db: 'shop' } }
  },
  {
    name: 'Code',
    input: '{ c: Code("function () { return 1 }") }',
    expected: { c: { $code: 'function () { return 1 }' } }
  },
  { name: 'Symbol', input: '{ s: Symbol("sym") }', expected: { s: { $symbol: 'sym' } } },
  { name: 'null', input: '{ a: null }', expected: { a: null } },
  { name: 'undefined becomes null', input: '{ a: undefined }', expected: { a: null } },
  { name: 'booleans', input: '{ a: true, b: false }', expected: { a: true, b: false } },

  // ------------------------------------------------------------------ regex forms
  { name: 'regex no flags', input: '{ s: /abc/ }', expected: { s: re('abc') } },
  { name: 'regex multiple flags', input: '{ s: /a.b/im }', expected: { s: re('a.b', 'im') } },
  // Regex literals can't use the "s" (dotAll) flag in Compass's parser; $options can.
  {
    name: 'dotAll via $options',
    input: '{ s: { $regex: "a.b", $options: "si" } }',
    expected: { s: { $regex: 'a.b', $options: 'si' } }
  },
  {
    name: 'regex with escaped slash',
    input: '{ url: /https:\\/\\/x/ }',
    expected: { url: re('https:\\/\\/x') }
  },
  {
    name: 'regex with char class and anchors',
    input: '{ code: /^[A-Z]{3}-\\d+$/ }',
    expected: { code: re('^[A-Z]{3}-\\d+$') }
  },
  { name: 'RegExp constructor', input: '{ s: RegExp("^a", "i") }', expected: { s: re('^a', 'i') } },
  { name: 'new RegExp', input: '{ s: new RegExp("a.b") }', expected: { s: re('a.b') } },
  {
    name: '$regex with $options',
    input: '{ s: { $regex: "^a", $options: "i" } }',
    expected: { s: { $regex: '^a', $options: 'i' } }
  },
  {
    name: '$regex with regex literal',
    input: '{ s: { $regex: /^a/i } }',
    expected: { s: { $regex: re('^a', 'i') } }
  },
  {
    name: '$in with regexes',
    input: '{ s: { $in: [/^a/, /^b/] } }',
    expected: { s: { $in: [re('^a'), re('^b')] } }
  },
  { name: '$not with regex', input: '{ s: { $not: /^a/ } }', expected: { s: { $not: re('^a') } } },

  // ------------------------------------------------------------------ comparison operators
  { name: '$eq', input: '{ a: { $eq: 1 } }', expected: { a: { $eq: i(1) } } },
  { name: '$ne', input: '{ a: { $ne: "x" } }', expected: { a: { $ne: 'x' } } },
  { name: '$gt/$lt range', input: '{ a: { $gt: 1, $lt: 10 } }', expected: { a: { $gt: i(1), $lt: i(10) } } },
  {
    name: '$gte/$lte dates',
    input: '{ d: { $gte: ISODate("2026-02-01"), $lte: ISODate("2026-03-01") } }',
    expected: { d: { $gte: date(1769904000000), $lte: date(1772323200000) } }
  },
  { name: '$in', input: '{ s: { $in: ["a", "b", 3] } }', expected: { s: { $in: ['a', 'b', i(3)] } } },
  { name: '$nin', input: '{ s: { $nin: [null, ""] } }', expected: { s: { $nin: [null, ''] } } },

  // ------------------------------------------------------------------ logical
  { name: '$and', input: '{ $and: [{ a: 1 }, { b: 2 }] }', expected: { $and: [{ a: i(1) }, { b: i(2) }] } },
  {
    name: '$or',
    input: '{ $or: [{ a: 1 }, { b: { $exists: false } }] }',
    expected: { $or: [{ a: i(1) }, { b: { $exists: false } }] }
  },
  { name: '$nor', input: '{ $nor: [{ a: 1 }] }', expected: { $nor: [{ a: i(1) }] } },
  {
    name: '$not with operator',
    input: '{ a: { $not: { $gt: 5 } } }',
    expected: { a: { $not: { $gt: i(5) } } }
  },

  // ------------------------------------------------------------------ element
  { name: '$exists', input: '{ a: { $exists: true } }', expected: { a: { $exists: true } } },
  { name: '$type by name', input: '{ a: { $type: "string" } }', expected: { a: { $type: 'string' } } },
  { name: '$type by number', input: '{ a: { $type: 18 } }', expected: { a: { $type: i(18) } } },
  {
    name: '$type array of types',
    input: '{ a: { $type: ["double", "int", "long", "decimal"] } }',
    expected: { a: { $type: ['double', 'int', 'long', 'decimal'] } }
  },

  // ------------------------------------------------------------------ evaluation
  { name: '$mod', input: '{ n: { $mod: [4, 0] } }', expected: { n: { $mod: [i(4), i(0)] } } },
  {
    name: '$expr with $dateDiff',
    input: '{ $expr: { $lt: [{ $dateDiff: { startDate: "$start", endDate: "$$NOW", unit: "day" } }, 7] } }',
    expected: {
      $expr: { $lt: [{ $dateDiff: { startDate: '$start', endDate: '$$NOW', unit: 'day' } }, i(7)] }
    }
  },
  {
    name: '$jsonSchema',
    input:
      '{ $jsonSchema: { bsonType: "object", required: ["name"], properties: { name: { bsonType: "string" }, age: { bsonType: "int", minimum: 0 } } } }',
    expected: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name'],
        properties: { name: { bsonType: 'string' }, age: { bsonType: 'int', minimum: i(0) } }
      }
    }
  },
  {
    name: '$text with options',
    input: '{ $text: { $search: "\\"cold brew\\" -iced", $language: "en", $caseSensitive: false } }',
    expected: { $text: { $search: '"cold brew" -iced', $language: 'en', $caseSensitive: false } }
  },
  {
    name: '$where string (kept as a string, run by the server only)',
    input: '{ $where: "this.a > this.b" }',
    expected: { $where: 'this.a > this.b' }
  },

  // ------------------------------------------------------------------ array
  { name: '$all', input: '{ tags: { $all: ["a", "b"] } }', expected: { tags: { $all: ['a', 'b'] } } },
  { name: '$size', input: '{ tags: { $size: 3 } }', expected: { tags: { $size: i(3) } } },
  {
    name: '$elemMatch with multiple conditions',
    input: '{ items: { $elemMatch: { qty: { $gte: 2 }, price: { $lt: NumberDecimal("9.99") } } } }',
    expected: { items: { $elemMatch: { qty: { $gte: i(2) }, price: { $lt: dec('9.99') } } } }
  },
  { name: 'array equality', input: '{ tags: ["a", "b"] }', expected: { tags: ['a', 'b'] } },
  { name: 'nested arrays', input: '{ m: [1, [2, { a: 3 }]] }', expected: { m: [i(1), [i(2), { a: i(3) }]] } },

  // ------------------------------------------------------------------ geo
  {
    name: '$geoWithin $centerSphere',
    input: '{ loc: { $geoWithin: { $centerSphere: [[79.86, 6.92], 0.01] } } }',
    expected: { loc: { $geoWithin: { $centerSphere: [[dbl('79.86'), dbl('6.92')], dbl('0.01')] } } }
  },
  {
    name: '$geoWithin $box',
    input: '{ loc: { $geoWithin: { $box: [[0, 0], [10, 10]] } } }',
    expected: {
      loc: {
        $geoWithin: {
          $box: [
            [i(0), i(0)],
            [i(10), i(10)]
          ]
        }
      }
    }
  },
  {
    name: '$geoIntersects polygon',
    input:
      '{ area: { $geoIntersects: { $geometry: { type: "Polygon", coordinates: [[[0,0],[3,6],[6,1],[0,0]]] } } } }',
    expected: {
      area: {
        $geoIntersects: {
          $geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [i(0), i(0)],
                [i(3), i(6)],
                [i(6), i(1)],
                [i(0), i(0)]
              ]
            ]
          }
        }
      }
    }
  },
  {
    name: '$near with distances',
    input:
      '{ loc: { $near: { $geometry: { type: "Point", coordinates: [0, 0] }, $maxDistance: 1000, $minDistance: 10 } } }',
    expected: {
      loc: {
        $near: {
          $geometry: { type: 'Point', coordinates: [i(0), i(0)] },
          $maxDistance: i(1000),
          $minDistance: i(10)
        }
      }
    }
  },
  {
    name: '$nearSphere legacy',
    input: '{ loc: { $nearSphere: [1.5, 2.5] } }',
    expected: { loc: { $nearSphere: [dbl('1.5'), dbl('2.5')] } }
  },

  // ------------------------------------------------------------------ bitwise
  {
    name: '$bitsAllSet positions',
    input: '{ f: { $bitsAllSet: [1, 5] } }',
    expected: { f: { $bitsAllSet: [i(1), i(5)] } }
  },
  { name: '$bitsAnySet mask', input: '{ f: { $bitsAnySet: 35 } }', expected: { f: { $bitsAnySet: i(35) } } },
  {
    name: '$bitsAllClear BinData',
    input: '{ f: { $bitsAllClear: BinData(0, "IA==") } }',
    expected: { f: { $bitsAllClear: bin('IA==', '00') } }
  },
  {
    name: '$bitsAnyClear',
    input: '{ f: { $bitsAnyClear: [0] } }',
    expected: { f: { $bitsAnyClear: [i(0)] } }
  },

  // ------------------------------------------------------------------ project / sort / collation
  {
    name: 'project include/exclude',
    field: 'project',
    input: '{ name: 1, _id: 0 }',
    expected: { name: i(1), _id: i(0) }
  },
  {
    name: 'project $slice',
    field: 'project',
    input: '{ items: { $slice: [0, 5] } }',
    expected: { items: { $slice: [i(0), i(5)] } }
  },
  {
    name: 'project $elemMatch',
    field: 'project',
    input: '{ items: { $elemMatch: { sku: "A" } } }',
    expected: { items: { $elemMatch: { sku: 'A' } } }
  },
  {
    name: 'project aggregation expression',
    field: 'project',
    input: '{ total: { $sum: "$items.price" } }',
    expected: { total: { $sum: '$items.price' } }
  },
  {
    name: 'project $meta textScore',
    field: 'project',
    input: '{ score: { $meta: "textScore" } }',
    expected: { score: { $meta: 'textScore' } }
  },
  {
    name: 'sort object',
    field: 'sort',
    input: '{ createdAt: -1, _id: 1 }',
    expected: { createdAt: i(-1), _id: i(1) }
  },
  {
    name: 'sort by textScore',
    field: 'sort',
    input: '{ score: { $meta: "textScore" } }',
    expected: { score: { $meta: 'textScore' } }
  },
  {
    name: 'collation',
    field: 'collation',
    input: '{ locale: "en", strength: 2 }',
    expected: { locale: 'en', strength: i(2) }
  },
  {
    name: 'collation numericOrdering',
    field: 'collation',
    input: '{ locale: "en_US", numericOrdering: true, caseLevel: false }',
    expected: { locale: 'en_US', numericOrdering: true, caseLevel: false }
  },

  // ------------------------------------------------------------------ must be rejected
  { name: 'unclosed brace', input: '{ a: ', error: /Unexpected token|syntax/i },
  {
    name: 'unknown function is never executed',
    input: '{ a: foo() }',
    error: /not supported|Unsupported|invalid/i
  },
  {
    name: 'process access is rejected',
    input: '{ a: process.exit(1) }',
    error: /not supported|Unsupported|invalid/i
  },
  {
    name: 'IIFE is rejected',
    input: '{ a: (function () { return 1 })() }',
    error: /not supported|Unsupported|invalid/i
  },
  { name: 'require is rejected', input: '{ a: require("fs") }', error: /not supported|Unsupported|invalid/i },
  { name: 'template literal is rejected', input: '{ a: `x` }', error: /not supported|Unsupported|invalid/i },
  { name: 'invalid ISODate', input: '{ d: ISODate("2026-13-45") }', error: /not a valid ISODate/ },
  {
    name: 'top-level array is not a filter',
    input: '[1, 2]',
    error: /must be an object|not supported|Unsupported|invalid/i
  },
  {
    name: 'bare string is not a filter',
    input: '"abc"',
    error: /must be an object|not supported|Unsupported|invalid/i
  },
  {
    name: 'regex literal s flag is rejected (use $options)',
    input: '{ s: /a.b/s }',
    error: /Invalid regular expression flag/
  },
  { name: 'unbalanced brackets', input: '{ a: [1, 2 }', error: /Unexpected token|syntax/i }
]

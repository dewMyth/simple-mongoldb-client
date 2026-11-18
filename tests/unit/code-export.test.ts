import { describe, expect, it } from 'vitest'
import { BSON, type Document } from 'bson'
import { exportLanguages, exportQuery, type ExportableQuery } from '../../src/shared/code-export'
import {
  convertQueryText,
  parseQuery,
  parseQueryField,
  parseShellValue
} from '../../src/main/services/query-parser'
import { emptyQueryText } from '../../src/shared/query'
import { stringifyCanonical } from '../../src/shared/ejson'
import { toShellString } from '../../src/shared/shell-format'
import { allTypesDoc } from '../fixtures/all-types'

const target = { db: 'shop', collection: 'orders' }

function parsed(filter: string, extra: Partial<typeof emptyQueryText> = {}): ExportableQuery {
  const r = parseQuery({ ...emptyQueryText, filter, ...extra })
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.query
}

const typed = parsed(
  "{ _id: ObjectId('65f1c0a1b2c3d4e5f6a7b8c9'), n: NumberLong('9007199254740993'), i: 5, d: Double(10), f: 2.5, x: NumberDecimal('1.50'), when: ISODate('2024-01-01T00:00:00Z'), re: /ab+c/i, u: UUID('3b241101-e2bb-4255-8caf-4136c566a962'), b: BinData(128, 'AAEC'), ts: Timestamp({ t: 1700000000, i: 3 }), lo: MinKey(), nil: null }"
)

describe('exportQuery: exact BSON types per language', () => {
  it('Node', () => {
    const code = exportQuery('node', target, typed)
    for (const frag of [
      'new ObjectId("65f1c0a1b2c3d4e5f6a7b8c9")',
      'Long.fromString("9007199254740993")',
      'i: 5',
      'd: new Double(10)',
      'f: 2.5',
      'Decimal128.fromString("1.50")',
      'new Date("2024-01-01T00:00:00.000Z")',
      'new BSONRegExp("ab+c", "i")',
      'new UUID("3b241101-e2bb-4255-8caf-4136c566a962")',
      'new Binary(Buffer.from("AAEC", "base64"), 128)',
      'new Timestamp({ t: 1700000000, i: 3 })',
      'new MinKey()',
      'nil: null'
    ])
      expect(code).toContain(frag)
    expect(code).toMatch(
      /^import \{ MongoClient, BSONRegExp, Binary, Decimal128, Double, Long, MinKey, ObjectId, Timestamp, UUID \} from "mongodb"$/m
    )
  })

  it('Python', () => {
    const code = exportQuery('python', target, typed)
    for (const frag of [
      'ObjectId("65f1c0a1b2c3d4e5f6a7b8c9")',
      'Int64(9007199254740993)',
      '"i": 5',
      '"d": 10.0',
      'Decimal128("1.50")',
      'datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)',
      'Regex("ab+c", "i")',
      'Binary.from_uuid(UUID("3b241101-e2bb-4255-8caf-4136c566a962"))',
      'Binary(base64.b64decode("AAEC"), 128)',
      'Timestamp(1700000000, 3)',
      '"nil": None',
      'from bson.int64 import Int64'
    ])
      expect(code).toContain(frag)
  })

  it('Java', () => {
    const code = exportQuery('java', target, typed)
    for (const frag of [
      'new Document("_id", new ObjectId("65f1c0a1b2c3d4e5f6a7b8c9"))',
      '.append("n", 9007199254740993L)',
      '.append("i", 5)',
      '.append("d", 10.0)',
      'Decimal128.parse("1.50")',
      'Date.from(Instant.parse("2024-01-01T00:00:00.000Z"))',
      'new BsonRegularExpression("ab+c", "i")',
      'new BsonBinary(UUID.fromString("3b241101-e2bb-4255-8caf-4136c566a962"))',
      'new Binary((byte) 128, Base64.getDecoder().decode("AAEC"))',
      'new BsonTimestamp(1700000000, 3)',
      'import org.bson.types.Decimal128;'
    ])
      expect(code).toContain(frag)
  })

  it('C#', () => {
    const code = exportQuery('csharp', target, typed)
    for (const frag of [
      '{ "_id", ObjectId.Parse("65f1c0a1b2c3d4e5f6a7b8c9") }',
      '{ "n", 9007199254740993L }',
      '{ "d", 10.0 }',
      'new BsonDecimal128(Decimal128.Parse("1.50"))',
      'new BsonDateTime(1704067200000)',
      'GuidRepresentation.Standard',
      '(BsonBinarySubType)128',
      '{ "nil", BsonNull.Value }'
    ])
      expect(code).toContain(frag)
  })

  it('Go (driver v2), with trailing commas on multi-line literals', () => {
    const code = exportQuery('go', target, typed)
    for (const frag of [
      '{Key: "_id", Value: oid("65f1c0a1b2c3d4e5f6a7b8c9")}',
      '{Key: "n", Value: int64(9007199254740993)}',
      '{Key: "i", Value: int32(5)}',
      '{Key: "d", Value: float64(10)}',
      'dec("1.50")',
      'bson.DateTime(1704067200000)',
      'bson.Binary{Subtype: 0x80, Data: b64("AAEC")}',
      'bson.Timestamp{T: 1700000000, I: 3}',
      '"go.mongodb.org/mongo-driver/v2/bson"',
      'func oid(hex string) bson.ObjectID'
    ])
      expect(code).toContain(frag)
    // A multi-line composite literal must end with a comma before its closing brace.
    expect(code).toContain('{Key: "nil", Value: nil},\n\t}')
  })

  it('mongosh reuses the round-trippable shell syntax', () => {
    const code = exportQuery('shell', target, typed)
    expect(code).toContain('NumberLong("9007199254740993")')
    expect(code).toContain('d: Double(10)')
    expect(code.startsWith('db.getSiblingDB("shop").orders.find(')).toBe(true)
    expect(exportQuery('shell', { db: 'shop', collection: 'my-orders' }, parsed('{}'), 'count')).toBe(
      'db.getSiblingDB("shop").getCollection("my-orders").countDocuments({})\n'
    )
  })

  it('applies every option in find and count mode', () => {
    const q = parsed("{ status: 'paid' }", {
      project: '{ a: 1 }',
      sort: '{ a: -1 }',
      skip: '5',
      limit: '10',
      collation: "{ locale: 'en', strength: 2 }",
      hint: 'status_1',
      maxTimeMS: '500'
    })
    const node = exportQuery('node', target, q)
    for (const f of [
      'projection: { a: 1 }',
      'sort: { a: -1 }',
      'skip: 5',
      'limit: 10',
      'hint: "status_1"',
      'maxTimeMS: 500'
    ])
      expect(node).toContain(f)
    const py = exportQuery('python', target, q, 'count')
    expect(py).toContain('count_documents(')
    expect(py).toContain('maxTimeMS=500')
    expect(py).not.toContain('projection') // count ignores projection/sort
    expect(exportQuery('java', target, q)).toContain('.hintString("status_1")')
    expect(exportQuery('java', target, q)).toContain('CollationStrength.fromInt(2)')
    expect(exportQuery('go', target, q)).toContain(
      'context.WithTimeout(context.Background(), 500*time.Millisecond)'
    )
    expect(exportQuery('csharp', target, q, 'count')).toContain('Skip = 5')
  })

  it('never embeds a connection string or credentials', () => {
    for (const lang of exportLanguages) {
      const code = exportQuery(lang, target, typed)
      expect(code).not.toMatch(/mongodb(\+srv)?:\/\/[^"]*@/)
      if (lang !== 'shell') expect(code).toContain('MONGODB_URI')
    }
  })

  it('exports every type in the all-types fixture without throwing', () => {
    const doc = allTypesDoc()
    for (const lang of exportLanguages)
      expect(exportQuery(lang, target, { filter: doc }).length).toBeGreaterThan(100)
  })
})

describe('Extended JSON input and conversion', () => {
  const doc = (() => {
    const d = allTypesDoc()
    delete d.regexFlags // s/x flags have no shell syntax (documented limit)
    return d
  })()
  const bytes = (v: unknown) => Buffer.from(BSON.serialize(v as Document)).toString('hex')

  it('accepts canonical EJSON as query text, keeping every type', () => {
    const r = parseQueryField('filter', stringifyCanonical(doc))
    expect(r.ok && bytes(r.value)).toBe(bytes(doc))
  })

  it('accepts EJSON in document bodies (insert/edit)', () => {
    const r = parseShellValue(
      stringifyCanonical({ _id: { $oid: 'x' } }).replace('"x"', '"65f1c0a1b2c3d4e5f6a7b8c9"')
    )
    expect(r.ok).toBe(true)
  })

  it('still treats shell syntax mentioning $oid as shell syntax', () => {
    const r = parseQueryField('filter', '{ note: \'"$oid": not ejson\', n: 1 }')
    expect(r.ok).toBe(true)
  })

  it('reports invalid EJSON clearly', () => {
    const r = parseQueryField('filter', '{ "a": { "$numberLong": 5 } }')
    expect(!r.ok && r.error.message).toMatch(/Extended JSON/)
  })

  it('shell → canonical → shell round-trips byte-identically', () => {
    const shell = toShellString(doc, 2)
    const canonical = convertQueryText(shell, 'filter', 'canonical')!
    expect(canonical).toContain('"$numberLong"')
    const back = convertQueryText(canonical, 'filter', 'shell')!
    const r = parseQueryField('filter', back)
    expect(r.ok && bytes(r.value)).toBe(bytes(doc))
  })

  it('relaxed EJSON writes plain numbers', () => {
    expect(
      convertQueryText('{ a: NumberLong(5), d: ISODate("2024-01-01T00:00:00Z") }', 'filter', 'relaxed')
    ).toBe('{"a":5,"d":{"$date":"2024-01-01T00:00:00Z"}}')
  })

  it('keeps short results on one line and returns null for invalid text', () => {
    expect(convertQueryText('{a:1}', 'filter', 'shell')).toBe('{ a: 1 }')
    expect(convertQueryText('{ a: ', 'filter', 'canonical')).toBeNull()
    expect(convertQueryText('', 'filter', 'canonical')).toBe('')
  })
})

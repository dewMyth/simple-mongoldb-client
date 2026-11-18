import { describe, expect, it } from 'vitest'
import { EJSON } from 'bson'
import { bsonTypeOf, displayScalar, type BsonTypeTag } from '../../src/shared/bson-types'
import { allTypesDoc } from '../fixtures/all-types'

/** Exactly what the renderer sees: canonical EJSON deserialized with types kept. */
const doc = EJSON.deserialize(EJSON.serialize(allTypesDoc(), { relaxed: false }), { relaxed: false })

describe('bsonTypeOf', () => {
  const expected: Record<string, BsonTypeTag> = {
    _id: 'objectId',
    string: 'string',
    int32: 'int32',
    int64: 'int64',
    double: 'double',
    doubleWhole: 'double',
    doubleNaN: 'double',
    decimal128: 'decimal128',
    boolTrue: 'boolean',
    date: 'date',
    datePre1970: 'date',
    null: 'null',
    binaryGeneric: 'binary',
    binaryUuid: 'uuid',
    binaryMd5: 'binary',
    timestamp: 'timestamp',
    regex: 'regex',
    regexFlags: 'regex',
    minKey: 'minKey',
    maxKey: 'maxKey',
    code: 'code',
    codeWithScope: 'code',
    symbol: 'symbol',
    dbRef: 'dbref',
    nested: 'object',
    mixedArray: 'array'
  }
  for (const [field, tag] of Object.entries(expected)) {
    it(`${field} → ${tag}`, () => expect(bsonTypeOf(doc[field])).toBe(tag))
  }

  it('covers every top-level field of the fixture', () => {
    for (const v of Object.values(doc)) expect(bsonTypeOf(v)).toBeTruthy()
  })
})

describe('displayScalar', () => {
  it('distinguishes numeric types', () => {
    expect(displayScalar(doc['int32'])).toBe('42')
    expect(displayScalar(doc['doubleWhole'])).toBe('10.0')
    expect(displayScalar(doc['int64'])).toBe('9007199254740993')
    expect(displayScalar(doc['decimal128'])).toBe('1234567890123456789012345678901234')
  })
  it('formats other types', () => {
    expect(displayScalar(doc['string'])).toBe('"héllo wörld 🌍"')
    expect(displayScalar(doc['datePre1970'])).toBe('1969-07-20T20:17:40.000Z')
    expect(displayScalar(doc['regexFlags'])).toBe('/a.b/imsx')
    expect(displayScalar(doc['binaryUuid'])).toBe('UUID("3b241101-e2bb-4255-8caf-4136c566a962")')
    expect(displayScalar(doc['_id'])).toBe('ObjectId("65f1c0a1b2c3d4e5f6a7b8c9")')
    expect(displayScalar(doc['timestamp'])).toBe('Timestamp({ t: 1700000000, i: 1 })')
  })
})

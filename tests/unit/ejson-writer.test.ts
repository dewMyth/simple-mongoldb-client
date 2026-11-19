import { describe, expect, it } from 'vitest'
import {
  Binary,
  BSON,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
  type Document
} from 'bson'
import { bsonToEJSON } from '../../src/main/services/import-export/ejson-writer'
import { allTypesDoc } from '../fixtures/all-types'

const DECODE = { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true } as const

/** What export wrote before: decode, then EJSON.stringify. The writer must match it exactly. */
function expected(bytes: Uint8Array, relaxed: boolean) {
  return EJSON.stringify(BSON.deserialize(bytes, DECODE) as Document, { relaxed })
}

function check(doc: Document) {
  const bytes = BSON.serialize(doc)
  for (const relaxed of [false, true])
    expect(bsonToEJSON(bytes, relaxed), `relaxed=${relaxed}`).toBe(expected(bytes, relaxed))
}

/** A deterministic pseudo-random generator, for reproducible fuzzing. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
}

function randomValue(r: () => number, depth: number): unknown {
  const pick = Math.floor(r() * (depth > 2 ? 16 : 18))
  switch (pick) {
    case 0:
      return (
        'str ' +
        String.fromCharCode(...Array.from({ length: Math.floor(r() * 8) }, () => 32 + Math.floor(r() * 2000)))
      )
    case 1:
      return new Int32(Math.floor((r() - 0.5) * 2 ** 32))
    case 2:
      return new Double(
        [r() * 1e6, -0, 0.1, 1e21, 1e-7, 5e-324, NaN, Infinity, -Infinity, 123][Math.floor(r() * 10)]!
      )
    case 3:
      return Long.fromBits(Math.floor(r() * 2 ** 32), Math.floor((r() - 0.5) * 2 ** 32))
    case 4:
      return Decimal128.fromString(
        [`${Math.floor(r() * 1e9)}.${Math.floor(r() * 100)}`, 'NaN', '-Infinity', '1E+6144', '-0.00'][
          Math.floor(r() * 5)
        ]!
      )
    case 5:
      return r() > 0.5
    case 6:
      return new Date(
        [Math.floor((r() - 0.3) * 4e12), 0, -1, 253402300800000, 253402300799999, 1700000000123][
          Math.floor(r() * 6)
        ]!
      )
    case 7:
      return new ObjectId()
    case 8:
      return null
    case 9:
      return new Binary(
        Uint8Array.from({ length: Math.floor(r() * 20) }, () => Math.floor(r() * 256)),
        [0, 4, 5, 128, 6][Math.floor(r() * 5)]!
      )
    case 10:
      return new Timestamp({ t: Math.floor(r() * 2 ** 32), i: Math.floor(r() * 2 ** 32) })
    case 11:
      return new BSONRegExp('a.b[c]"\\', ['', 'xmi', 'ims', 'u'][Math.floor(r() * 4)]!)
    case 12:
      return [new MinKey(), new MaxKey(), new BSONSymbol('sym'), new Code('return 1')][Math.floor(r() * 4)]
    case 13:
      return new Code('function () { return x }', { x: new Int32(1), y: 'z' })
    case 14:
      return new DBRef('orders', new ObjectId(), r() > 0.5 ? 'shop' : undefined)
    case 15:
      return new UUID().toBinary()
    case 16:
      return Array.from({ length: Math.floor(r() * 5) }, () => randomValue(r, depth + 1))
    default:
      return randomDoc(r, depth + 1)
  }
}

function randomDoc(r: () => number, depth = 0): Document {
  const doc: Document = {}
  const n = Math.floor(r() * 7)
  for (let i = 0; i < n; i++) doc[`k${i}${r() > 0.9 ? ' "quoted"\n' : ''}`] = randomValue(r, depth)
  return doc
}

describe('bsonToEJSON (export fast path) matches EJSON.stringify exactly', () => {
  it('the all-types fixture', () => check(allTypesDoc()))

  it('edge values', () => {
    check({
      d: [
        new Double(10),
        new Double(-0),
        new Double(0.1),
        new Double(1e21),
        new Double(1e-7),
        new Double(NaN),
        new Double(-Infinity)
      ],
      dates: [
        new Date(-1),
        new Date(0),
        new Date(253402300800000),
        new Date(1700000000000),
        new Date(1700000000001)
      ],
      longs: [Long.MAX_VALUE, Long.MIN_VALUE, Long.fromString('9007199254740993'), Long.fromNumber(-1)],
      regex: new BSONRegExp('^x', 'xmi'),
      empty: {},
      emptyArray: [],
      nested: [[[]], [{}], { a: [{ b: null }] }],
      'key "with" \\ escapes\u0001': 'value   🌍',
      bin: [new Binary(new Uint8Array(0), 0), new Binary(Uint8Array.of(1, 2, 3), 128)]
    })
  })

  it('300 random nested documents', () => {
    const r = rng(42)
    for (let i = 0; i < 300; i++) check(randomDoc(r))
  })

  it('falls back for old binary subtype 2', () => {
    const bytes = BSON.serialize({ b: new Binary(Uint8Array.of(9, 9), 2) })
    expect(bsonToEJSON(bytes, false)).toBe(expected(bytes, false))
  })
})

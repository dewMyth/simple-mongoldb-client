import { describe, expect, it } from 'vitest'
import { BSON, Double, Int32, Long, ObjectId } from 'bson'
import { parseQueryField } from '../../src/main/services/query-parser'
import { toShellString } from '../../src/shared/shell-format'
import { allTypesDoc } from '../fixtures/all-types'

const bytes = (d: unknown) => Buffer.from(BSON.serialize(d as never))

describe('shell format', () => {
  it('round-trips the all-types document through the query parser byte-for-byte', () => {
    const doc = allTypesDoc()
    // Known limit: regex "s"/"x" flags can't be written in shell syntax.
    delete doc['regexFlags']
    for (const indent of [0, 2]) {
      const text = toShellString(doc, indent)
      const parsed = parseQueryField('filter', text)
      if (!parsed.ok) throw new Error(`${parsed.error.message}\n${text}`)
      expect(bytes(parsed.value).equals(bytes(doc))).toBe(true)
    }
  })

  it('writes types unambiguously', () => {
    expect(toShellString({ a: new Double(10), b: new Int32(10), c: Long.fromNumber(10), d: 1.5 }, 0)).toBe(
      '{ a: Double(10), b: 10, c: NumberLong("10"), d: 1.5 }'
    )
    expect(toShellString({ _id: new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9') }, 0)).toBe(
      '{ _id: ObjectId("65f1c0a1b2c3d4e5f6a7b8c9") }'
    )
    expect(toShellString({ 'a.b': 1, 'x y': 2, ok_1: 3 }, 0)).toBe('{ "a.b": 1, "x y": 2, ok_1: 3 }')
  })

  it('pretty-prints with indentation', () => {
    expect(toShellString({ a: [1, { b: 2 }], c: {} })).toBe(
      '{\n  a: [\n    1,\n    {\n      b: 2\n    }\n  ],\n  c: {}\n}'
    )
  })
})

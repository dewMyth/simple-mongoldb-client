import { describe, expect, it } from 'vitest'
import { BSON, Decimal128, Double, Int32, Long, ObjectId, type Document } from 'bson'
import {
  conflictFilter,
  deleteAt,
  diffDocuments,
  getAt,
  insertAt,
  renameKey,
  sameValue,
  setAt,
  toDottedPath,
  updateFromDiff
} from '../../src/shared/doc-edit'
import { allTypesDoc } from '../fixtures/all-types'

const clone = (d: Document) => BSON.deserialize(BSON.serialize(d), { promoteValues: false, bsonRegExp: true })

describe('path operations (immutable)', () => {
  const doc = { a: 1, b: { c: [10, { d: 'x' }] } }

  it('gets and sets nested values without mutating the original', () => {
    expect(getAt(doc, ['b', 'c', 1, 'd'])).toBe('x')
    const next = setAt(doc, ['b', 'c', 1, 'd'], 'y')
    expect(getAt(next, ['b', 'c', 1, 'd'])).toBe('y')
    expect(getAt(doc, ['b', 'c', 1, 'd'])).toBe('x')
    expect(next.a).toBe(1)
  })

  it('deletes object keys and array elements', () => {
    expect(deleteAt(doc, ['a'])).toEqual({ b: doc.b })
    expect(getAt(deleteAt(doc, ['b', 'c', 0]), ['b', 'c'])).toEqual([{ d: 'x' }])
  })

  it('renames keys in place, keeping order', () => {
    const r = renameKey({ x: 1, y: 2, z: 3 }, [], 'y', 'why')
    expect(Object.keys(r)).toEqual(['x', 'why', 'z'])
    expect(() => renameKey({ x: 1, y: 2 }, [], 'x', 'y')).toThrow(/already exists/)
  })

  it('inserts fields and array elements', () => {
    expect(Object.keys(insertAt({ a: 1, c: 3 }, [], 'b', 2, 1))).toEqual(['a', 'b', 'c'])
    expect(getAt(insertAt(doc, ['b', 'c'], 1, 'new'), ['b', 'c'])).toEqual([10, 'new', { d: 'x' }])
  })
})

describe('sameValue', () => {
  it('is type-sensitive', () => {
    expect(sameValue(new Int32(5), new Int32(5))).toBe(true)
    expect(sameValue(new Int32(5), Long.fromNumber(5))).toBe(false)
    expect(sameValue(new Int32(5), new Double(5))).toBe(false)
    expect(sameValue(Decimal128.fromString('1.0'), Decimal128.fromString('1.00'))).toBe(false)
    expect(sameValue(new Date(0), new Date(0))).toBe(true)
  })
})

describe('diffDocuments', () => {
  it('reports only changed paths, at the deepest level that changed', () => {
    const orig = { _id: 1, a: 'x', n: { p: 1, q: 2 }, arr: [1, 2, 3], gone: true }
    const edit = { _id: 1, a: 'y', n: { p: 1, q: 3, r: 4 }, arr: [1, 9, 3], added: 'new' }
    const d = diffDocuments(orig, edit)
    expect(d.set).toEqual([
      [['a'], 'y'],
      [['n', 'q'], 3],
      [['n', 'r'], 4],
      [['arr', 1], 9],
      [['added'], 'new']
    ])
    expect(d.unset).toEqual([['gone']])
  })

  it('sets a whole array when its length changes', () => {
    expect(diffDocuments({ a: [1, 2] }, { a: [1, 2, 3] }).set).toEqual([[['a'], [1, 2, 3]]])
  })

  it('treats a type change as a change', () => {
    expect(diffDocuments({ n: new Int32(5) }, { n: Long.fromNumber(5) }).set).toHaveLength(1)
  })

  it('ignores key order (reordering is cosmetic)', () => {
    expect(diffDocuments({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 2, x: 1 }, a: 1 })).toEqual({
      set: [],
      unset: []
    })
  })

  it('an untouched all-types document has no diff', () => {
    expect(diffDocuments(allTypesDoc(), clone(allTypesDoc()))).toEqual({ set: [], unset: [] })
  })
})

describe('update + conflict filter', () => {
  const id = new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9')
  const orig = { _id: id, a: 'x', n: { q: 2 }, gone: true }
  const edit = { _id: id, a: 'y', n: { q: 3 }, added: 1 }
  const d = diffDocuments(orig, edit)

  it('builds $set / $unset with dotted paths', () => {
    expect(updateFromDiff(d)).toEqual({ $set: { a: 'y', 'n.q': 3, added: 1 }, $unset: { gone: '' } })
  })

  it('filters on _id plus the original value of every changed path', () => {
    expect(conflictFilter(orig, d)).toEqual({
      _id: { $eq: id },
      a: { $eq: 'x' },
      'n.q': { $eq: 2 },
      added: { $exists: false },
      gone: { $eq: true }
    })
  })

  it('refuses dotted paths for keys that need a full replacement', () => {
    expect(toDottedPath(['a', 'b'])).toBe('a.b')
    expect(toDottedPath(['dotted.key'])).toBeNull()
    expect(toDottedPath(['$weird'])).toBeNull()
    expect(toDottedPath(['a', ''])).toBeNull()
  })
})

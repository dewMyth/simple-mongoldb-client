import { describe, expect, it } from 'vitest'
import { Int32, Long } from 'bson'
import { collectFieldStats } from '../../src/shared/field-stats'

describe('collectFieldStats', () => {
  const docs = [
    { _id: 1, name: 'a', customer: { name: 'x', tier: 'gold' }, items: [{ sku: 'A' }, { sku: 'B', qty: 2 }] },
    { _id: 2, name: 3, customer: { name: 'y' }, tags: ['t'] },
    { _id: 3, qty: Long.fromNumber(5), n: new Int32(1) }
  ]
  const stats = collectFieldStats(docs)
  const byPath = Object.fromEntries(stats.map((s) => [s.path, s]))

  it('keeps first-seen order and dotted paths', () => {
    expect(stats.map((s) => s.path)).toEqual([
      '_id',
      'name',
      'customer',
      'customer.name',
      'customer.tier',
      'items',
      'items.sku',
      'items.qty',
      'tags',
      'qty',
      'n'
    ])
  })

  it('counts documents, not occurrences', () => {
    expect(byPath['items.sku']!.count).toBe(1) // twice in one document
    expect(byPath['customer.name']!.probability).toBeCloseTo(2 / 3)
  })

  it('records mixed types, most common first', () => {
    expect(byPath['name']!.types).toEqual([
      { type: 'string', count: 1 },
      { type: 'int32', count: 1 }
    ])
    expect(byPath['qty']!.types).toEqual([{ type: 'int64', count: 1 }])
    expect(byPath['customer']!.types).toEqual([{ type: 'object', count: 2 }])
  })

  it('respects maxDepth and maxPaths', () => {
    expect(collectFieldStats(docs, { maxDepth: 0 }).every((s) => s.depth === 0)).toBe(true)
    expect(collectFieldStats(docs, { maxPaths: 3 })).toHaveLength(3)
  })
})

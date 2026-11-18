import { describe, expect, it } from 'vitest'
import { Int32, BSONRegExp } from 'bson'
import {
  analyzeExplain,
  suggestIndexKeys,
  type AnalyzeContext,
  type PlanNode
} from '../../src/shared/explain'
import fixtures from '../fixtures/explain-8.2.json'

type Doc = Record<string, unknown>
const ctx = (p: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  kind: 'find',
  filter: null,
  sort: null,
  docCount: 3000,
  indexKeys: [{ _id: 1 }, { i: 1 }],
  ...p
})
const stages = (n: PlanNode): string[] => [n.stage, ...n.children.flatMap(stages)]

describe('analyzeExplain on real MongoDB 8.2 output', () => {
  it('collection scan + in-memory sort: warns and suggests an ESR index', () => {
    const r = analyzeExplain(
      fixtures.collscan as Doc,
      ctx({ filter: { status: 'a', total: { $gt: 50 } }, sort: { total: -1 } })
    )
    expect(stages(r.tree)).toEqual(['SORT', 'COLLSCAN'])
    expect(r.summary).toMatchObject({
      collscan: true,
      inMemorySort: true,
      docsExamined: 3000,
      keysExamined: 0,
      nReturned: 5,
      engine: 'classic'
    })
    expect(r.tree.children[0]).toMatchObject({
      stage: 'COLLSCAN',
      docsExamined: 3000,
      nReturned: 490,
      kind: 'collscan'
    })
    expect(r.hints.map((h) => h.kind)).toEqual(['collscan', 'sort'])
    // Equality (status), then Sort (total desc); total is also the range field.
    expect(r.suggestion).toMatchObject({
      keyText: '{ status: 1, total: -1 }',
      name: 'status_1_total_-1',
      exists: false
    })
  })

  it('index scan: reports the index, no hints', () => {
    const r = analyzeExplain(
      fixtures.ixscan as Doc,
      ctx({ filter: { i: { $gt: 10, $lt: 100 } }, sort: { i: 1 } })
    )
    expect(stages(r.tree)).toEqual(['PROJECTION_SIMPLE', 'FETCH', 'IXSCAN'])
    expect(r.summary).toMatchObject({
      collscan: false,
      inMemorySort: false,
      indexes: ['i_1'],
      nReturned: 89,
      keysExamined: 89
    })
    expect(r.hints).toEqual([])
    expect(r.suggestion).toBeNull()
  })

  it('_id lookup uses the express path', () => {
    const r = analyzeExplain(fixtures.idhack as Doc, ctx({ filter: { _id: 1 } }))
    expect(r.summary.indexes).toEqual(['_id_'])
    expect(r.tree.kind).toBe('ixscan')
  })

  it('aggregation on SBE: plan from queryPlan, pipeline stages on top, totals kept', () => {
    const r = analyzeExplain(fixtures.agg as Doc, ctx({ kind: 'aggregate', filter: { status: 'a' } }))
    expect(stages(r.tree)).toEqual(['$sort', 'GROUP', 'COLLSCAN'])
    expect(r.summary).toMatchObject({ engine: 'sbe', collscan: true, docsExamined: 3000, nReturned: 100 })
    expect(r.notes.join(' ')).toMatch(/Slot-based/)
    // $sort after $group can't use an index: no sort hint for it.
    expect(r.hints.map((h) => h.kind)).toEqual(['collscan'])
    expect(r.suggestion?.keyText).toBe('{ status: 1 }')
  })

  it('aggregation with $lookup: EQ_LOOKUP details and the index used', () => {
    const r = analyzeExplain(fixtures.aggLookup as Doc, ctx({ kind: 'aggregate', filter: { i: { $lt: 5 } } }))
    expect(stages(r.tree)).toEqual(['$addFields', '$project', 'EQ_LOOKUP', 'FETCH', 'IXSCAN'])
    const lookup = r.tree.children[0]!.children[0]!
    expect(lookup.details).toEqual([expect.stringMatching(/^from x\.t \(.*via i_1\)$/)])
    expect(r.summary.indexes).toEqual(['i_1'])
  })

  it('says when the suggested index already exists', () => {
    const r = analyzeExplain(
      fixtures.collscan as Doc,
      ctx({ filter: { status: 'a' }, indexKeys: [{ status: 1 }] })
    )
    expect(r.suggestion?.exists).toBe(true)
    expect(r.hints.map((h) => h.kind)).toContain('unused-index')
  })

  it('no collection-scan warning on small collections', () => {
    const r = analyzeExplain(
      fixtures.collscan as Doc,
      ctx({ filter: { status: 'a' }, sort: null, docCount: 50 })
    )
    expect(r.hints.filter((h) => h.kind === 'collscan')).toEqual([])
  })
})

describe('suggestIndexKeys (Equality, Sort, Range)', () => {
  it('orders equality, then sort, then range fields', () => {
    expect(
      suggestIndexKeys(
        { age: { $gte: 18 }, status: 'A', 'customer.tier': { $in: ['gold', 'silver'] } },
        { createdAt: -1 }
      )
    ).toEqual([
      { field: 'status', direction: 1 },
      { field: 'customer.tier', direction: 1 },
      { field: 'createdAt', direction: -1 },
      { field: 'age', direction: 1 }
    ])
  })
  it('handles $and, regexes, BSON values and sort direction types', () => {
    expect(
      suggestIndexKeys({ $and: [{ a: new Int32(1) }, { b: new BSONRegExp('^x', '') }] }, { c: new Int32(-1) })
    ).toEqual([
      { field: 'a', direction: 1 },
      { field: 'c', direction: -1 },
      { field: 'b', direction: 1 }
    ])
  })
  it('ignores what an index can’t serve', () => {
    expect(suggestIndexKeys({ $or: [{ a: 1 }, { b: 2 }], $expr: { $gt: ['$a', '$b'] } }, null)).toBeNull()
  })
})

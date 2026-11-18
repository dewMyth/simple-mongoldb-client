import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/shared/autocomplete/context'
import { complete, hoverAt, type CompletionMode } from '../../src/shared/autocomplete/complete'
import { toSnippet } from '../../src/shared/autocomplete/operators'
import { objectIdAt } from '../../src/shared/autocomplete/snippets'
import { collectFieldStats } from '../../src/shared/field-stats'

const fields = collectFieldStats(
  [
    {
      _id: 1,
      customer: { name: 'Ada', tier: 'gold' },
      status: 'paid',
      total: 10,
      items: [{ sku: 'A1', qty: 2 }],
      tags: ['red']
    },
    {
      _id: 2,
      customer: { name: 'Bob', tier: 'silver' },
      status: 'pending',
      total: 5.5,
      items: [],
      tags: ['blue', 'red']
    },
    { _id: 3, customer: { name: 'Cy', tier: 'gold' }, status: 'paid', created: new Date(0) }
  ],
  { maxValues: 50 }
)

/** Completes at the "|" marker. */
function at(mode: CompletionMode, textWithCursor: string) {
  const offset = textWithCursor.indexOf('|')
  const text = textWithCursor.slice(0, offset) + textWithCursor.slice(offset + 1)
  const r = complete(text, offset, { mode, fields, now: new Date('2026-11-18T12:00:00Z') })
  return { ...r, labels: r.suggestions.map((s) => s.label), text, offset }
}

describe('analyze (cursor context)', () => {
  it('tracks keys, values and nesting through incomplete text', () => {
    const c = analyze('{ a: { $gt', 10)
    expect(c.position).toBe('key')
    expect(c.prefix).toBe('$gt')
    expect(c.frames.map((f) => f.key)).toEqual(['a', null])
  })

  it('knows a value position, including inside strings', () => {
    const c = analyze('{ status: "pa', 13)
    expect(c.position).toBe('value')
    expect(c.quote).toBe('"')
    expect(c.prefix).toBe('pa')
    expect(c.prefixStart).toBe(11)
  })

  it('skips complete strings, regexes, comments and constructor calls', () => {
    const t = '{ a: "x:{", b: /a[/]b{/i, // { c:\n d: ObjectId("{"), e: '
    const c = analyze(t, t.length)
    expect(c.position).toBe('value')
    expect(c.frames).toHaveLength(1)
    expect(c.frames[0]!.key).toBe('e')
  })

  it('handles dotted unquoted keys as one prefix', () => {
    expect(analyze('{ customer.na', 14).prefix).toBe('customer.na')
  })

  it('reports nothing to suggest inside a constructor call or after a complete value', () => {
    expect(analyze('{ a: ObjectId("', 15).position).toBe('none')
    expect(analyze('{ a: NumberLong(', 16).position).toBe('none')
    expect(analyze('{ a: 1 ', 7).position).toBe('none')
  })

  it('detects a colon after the cursor', () => {
    expect(analyze('{ sta: 1 }', 5).colonAfter).toBe(true)
  })
})

describe('field completions (Done when: `{ cus` suggests customer.name with its type)', () => {
  it('suggests dotted paths with types and frequency', () => {
    const r = at('filter', '{ cus|')
    const s = r.suggestions.find((x) => x.label === 'customer.name')!
    expect(s).toBeDefined()
    expect(s.detail).toBe('String · 100%')
    expect(s.insertText).toBe('"customer.name"') // dotted names must be quoted
    expect(r.text.slice(r.replaceStart, r.replaceEnd)).toBe('cus')
  })

  it('inserts unquoted names inside a string', () => {
    const r = at('filter', "{ 'cus|")
    expect(r.suggestions.find((x) => x.label === 'customer.name')!.insertText).toBe('customer.name')
  })

  it('lists fields relative to the array inside $elemMatch', () => {
    const r = at('filter', '{ items: { $elemMatch: { | } } }')
    expect(r.labels).toContain('sku')
    expect(r.labels).toContain('$gt') // field operators apply to the elements
    expect(r.labels).not.toContain('items.sku')
  })
})

describe('operator completions by context', () => {
  it('offers top-level operators at the filter root and field operators inside a field', () => {
    expect(at('filter', '{ $|').labels).toEqual(expect.arrayContaining(['$and', '$or', '$expr']))
    expect(at('filter', '{ $|').labels).not.toContain('$gt')
    const inner = at('filter', '{ total: { $| } }').labels
    expect(inner).toEqual(expect.arrayContaining(['$gt', '$in', '$exists', '$regex']))
    expect(inner).not.toContain('$or')
  })

  it('switches to expression operators inside $expr', () => {
    const labels = at('filter', '{ $expr: { $| } }').labels
    expect(labels).toContain('$add')
    expect(labels).toContain('$dateDiff')
  })

  it('Done when: $match gets query operators, $group gets accumulators', () => {
    const match = at('pipeline', '[{ $match: { total: { $| } } }]').labels
    expect(match).toContain('$gte')
    expect(match).not.toContain('$sum')

    const group = at('pipeline', '[{ $match: {} }, { $group: { _id: "$status", n: { $| } } }]').labels
    expect(group).toEqual(expect.arrayContaining(['$sum', '$avg', '$push', '$addToSet']))
    expect(group).not.toContain('$exists')
    expect(group).not.toContain('$elemMatch')

    const project = at('pipeline', '[{ $project: { x: { $| } } }]').labels
    expect(project).toContain('$concat')
    expect(project).not.toContain('$exists')
  })

  it('suggests stages at a stage key and as array elements', () => {
    expect(at('pipeline', '[{ $|').labels).toEqual(expect.arrayContaining(['$match', '$group', '$lookup']))
    const el = at('pipeline', '[{ $match: {} }, |]')
    expect(el.labels).toContain('$group')
    expect(el.suggestions.find((s) => s.label === '$group')!.insertText).toMatch(/^\{ \\\$group: /)
  })

  it('offers named arguments of object-style operators', () => {
    expect(at('pipeline', '[{ $project: { x: { $cond: { | } } } }]').labels).toEqual(['if', 'then', 'else'])
    expect(at('pipeline', '[{ $lookup: { | } }]').labels).toEqual(
      expect.arrayContaining(['from', 'localField', 'foreignField', 'as'])
    )
  })

  it('treats nested $lookup pipelines and $facet as pipelines', () => {
    expect(at('pipeline', '[{ $lookup: { from: "x", pipeline: [{ $| }] } }]').labels).toContain('$match')
    expect(at('pipeline', '[{ $facet: { a: [{ $| }] } }]').labels).toContain('$group')
  })

  it('field paths inside expression strings', () => {
    const r = at('pipeline', '[{ $group: { _id: "$cust|" } }]')
    expect(r.labels).toContain('$customer.name')
    expect(r.labels).toContain('$$NOW')
    expect(r.text.slice(r.replaceStart, r.replaceEnd)).toBe('$cust')
  })

  it('update operators, then fields inside them', () => {
    expect(at('update', '{ $| }').labels).toEqual(expect.arrayContaining(['$set', '$inc', '$push']))
    expect(at('update', '{ $set: { | } }').labels).toContain('customer.name')
    expect(at('update', '{ $push: { tags: { $| } } }').labels).toEqual([
      '$each',
      '$slice',
      '$sort',
      '$position'
    ])
  })

  it('sort, projection and collation', () => {
    expect(at('sort', '{ total: | }').labels).toEqual(['1', '-1'])
    expect(at('project', '{ | }').labels).toContain('customer.name')
    expect(at('collation', '{ | }').labels).toContain('locale')
  })
})

describe('inserted text', () => {
  it('writes the operator with a template, unless a colon already follows', () => {
    const r = at('filter', '{ total: { $in| } }')
    expect(r.suggestions.find((s) => s.label === '$in')!.insertText).toBe('\\$in: [$1]')
    const c = at('filter', '{ total: { $i|: 1 } }')
    expect(c.suggestions.find((s) => s.label === '$in')!.insertText).toBe('\\$in')
  })

  it('escapes $ in snippets except placeholders', () => {
    expect(toSnippet('{ $match: { $1 } }')).toBe('{ \\$match: { $1 } }')
    expect(toSnippet('"\\$${1:field}"')).toBe('"\\$${1:field}"')
    expect(toSnippet('$$NOW')).toBe('\\$\\$NOW')
  })
})

describe('value suggestions', () => {
  it('suggests sampled values of low-cardinality string fields', () => {
    const r = at('filter', '{ status: | }')
    expect(r.labels.slice(0, 2)).toEqual(['"paid"', '"pending"']) // most frequent first
    expect(at('filter', '{ "customer.tier": "g|" }').labels).toContain('"gold"')
    expect(at('filter', '{ status: { $in: ["paid", | ] } }').labels).toContain('"pending"')
    expect(at('filter', '{ tags: | }').labels).toContain('"red"') // array elements count
  })

  it('offers BSON constructors and snippets in a value position', () => {
    const labels = at('filter', '{ created: | }').labels
    expect(labels).toContain('ObjectId')
    expect(labels).toContain('ISODate')
    expect(labels).toContain('Today')
    expect(labels).toContain('Last 7 days')
  })

  it('date snippets rank first for date fields, text snippets for strings', () => {
    const date = at('filter', '{ created: | }').suggestions.filter((s) => s.kind === 'snippet')
    expect(date[0]!.sortText < date.find((s) => s.label.startsWith('Contains'))!.sortText).toBe(true)
    const r = at('filter', '{ status: | }').suggestions
    const contains = r.find((s) => s.label.startsWith('Contains'))!
    const today = r.find((s) => s.label === 'Today')!
    expect(contains.sortText < today.sortText).toBe(true)
  })

  it('_id snippets use ObjectId timestamps', () => {
    expect(objectIdAt(new Date('2023-11-14T22:13:20Z'))).toBe('ObjectId("6553f1000000000000000000")')
    expect(at('filter', '{ _id: | }').labels).toContain('Created in the last 24 hours (from _id)')
  })
})

describe('hover', () => {
  it('documents operators, constructors and variables', () => {
    const text = '{ $expr: { $gt: ["$a", "$$NOW"] }, d: ISODate("x") }'
    expect(hoverAt(text, text.indexOf('$gt') + 1)!.markdown).toMatch(/\*\*\$gt\*\*/)
    expect(hoverAt(text, text.indexOf('$$NOW') + 2)!.markdown).toMatch(/current date/)
    expect(hoverAt(text, text.indexOf('ISODate') + 1)!.markdown).toMatch(/ISO-8601/)
    expect(hoverAt(text, text.indexOf('d:'))).toBeNull()
  })
})

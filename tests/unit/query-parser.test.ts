import { describe, expect, it } from 'vitest'
import type { Long } from 'bson'
import { formatQueryText, parseQuery, parseQueryField } from '../../src/main/services/query-parser'

const blank = {
  filter: '',
  project: '',
  sort: '',
  collation: '',
  hint: '',
  skip: '',
  limit: '',
  maxTimeMS: ''
}

describe('parseQuery', () => {
  it('parses every option', () => {
    const res = parseQuery({
      ...blank,
      filter: '{ _id: ObjectId("65f1c0a1b2c3d4e5f6a7b8c9") }',
      project: '{ a: 1 }',
      sort: '{ a: -1 }',
      collation: '{ locale: "en" }',
      hint: '{ a: 1 }',
      skip: '10',
      limit: '0',
      maxTimeMS: '5000'
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The parser uses bson's CJS build; compare by BSON type tag, not class identity.
    expect(res.query.filter._id._bsontype).toBe('ObjectId')
    expect(res.query).toMatchObject({
      project: { a: 1 },
      sort: { a: -1 },
      collation: { locale: 'en' },
      hint: { a: 1 },
      skip: 10,
      limit: 0,
      maxTimeMS: 5000
    })
  })

  it('treats empty options as unset', () => {
    const res = parseQuery(blank)
    expect(res).toEqual({ ok: true, query: { filter: {} } })
  })

  it('accepts an index name as hint', () => {
    const res = parseQuery({ ...blank, hint: 'status_1_createdAt_-1' })
    expect(res.ok && res.query.hint).toBe('status_1_createdAt_-1')
  })

  it('reports every invalid field at once', () => {
    const res = parseQuery({ ...blank, filter: '{ a: ', skip: '-1', limit: 'ten', maxTimeMS: '1.5' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.map((e) => e.field).sort()).toEqual(['filter', 'limit', 'maxTimeMS', 'skip'])
  })

  it('maps syntax error positions to the user text (1-based line, column)', () => {
    const res = parseQueryField('filter', '{\n  a: 1,\n  b: }')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.line).toBe(3)
    expect(res.error.column).toBeGreaterThanOrEqual(5)
  })

  it('keeps Int64 precision from string constructors', () => {
    const res = parseQueryField('filter', '{ n: NumberLong("9007199254740993") }')
    expect(res.ok && (res.value as { n: Long }).n.toString()).toBe('9007199254740993')
  })
})

describe('formatQueryText', () => {
  it('pretty-prints shell syntax and keeps types', () => {
    const out = formatQueryText(
      '{_id:ObjectId("65f1c0a1b2c3d4e5f6a7b8c9"),n:NumberLong("5"),d:ISODate("2026-01-01")}'
    )
    expect(out).toContain("ObjectId('65f1c0a1b2c3d4e5f6a7b8c9')")
    expect(out).toContain("NumberLong('5')")
    expect(out).toContain("ISODate('2026-01-01T00:00:00.000Z')")
    expect(out!.split('\n').length).toBeGreaterThan(1)
  })

  it('returns null for invalid input', () => {
    expect(formatQueryText('{ a: ')).toBeNull()
  })
})

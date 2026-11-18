import { describe, expect, it } from 'vitest'
import { parseQueryField } from '../../src/main/services/query-parser'
import { toCanonical } from '../../src/shared/ejson'
import { compassQueries } from '../fixtures/compass-queries'

describe('Compass compatibility corpus', () => {
  it('has at least 80 entries', () => {
    expect(compassQueries.length).toBeGreaterThanOrEqual(80)
    expect(new Set(compassQueries.map((q) => q.name)).size).toBe(compassQueries.length)
  })

  for (const q of compassQueries) {
    it(`${q.field ?? 'filter'}: ${q.name}`, () => {
      const res = parseQueryField(q.field ?? 'filter', q.input)
      if (q.error) {
        expect(res.ok, `expected an error for ${q.input}`).toBe(false)
        if (!res.ok) expect(res.error.message).toMatch(q.error)
      } else {
        if (!res.ok) throw new Error(`unexpected error: ${res.error.message}`)
        expect(toCanonical(res.value)).toEqual(q.expected)
      }
    })
  }
})

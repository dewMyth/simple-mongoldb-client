import { describe, expect, it } from 'vitest'
import { HISTORY_LIMIT, HistoryService, type HistoryData } from '../../src/main/services/history-service'
import { emptyQueryText } from '../../src/shared/query'

function memory() {
  let data: HistoryData = { history: {}, favorites: [] }
  return new HistoryService({ get: () => data, set: (d) => (data = d) })
}
const q = (filter: string) => ({ ...emptyQueryText, filter })

describe('history', () => {
  it('keeps the newest first, per namespace, capped at 200', () => {
    const h = memory()
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h.add('c1', 'db.a', q(`{ i: ${i} }`))
    h.add('c1', 'db.b', q('{ other: 1 }'))
    const a = h.list('c1', 'db.a')
    expect(a).toHaveLength(HISTORY_LIMIT)
    expect(a[0]!.query.filter).toBe(`{ i: ${HISTORY_LIMIT + 19} }`)
    expect(h.list('c1', 'db.b')).toHaveLength(1)
    expect(h.list('c2', 'db.a')).toHaveLength(0)
  })

  it('moves a re-run query to the top and ignores empty queries', () => {
    const h = memory()
    h.add('c', 'n', q('{ a: 1 }'))
    h.add('c', 'n', q('{ b: 1 }'))
    h.add('c', 'n', q(' { a: 1 } '))
    h.add('c', 'n', q(''))
    expect(h.list('c', 'n').map((e) => e.query.filter.trim())).toEqual(['{ a: 1 }', '{ b: 1 }'])
  })

  it('saves, renames and deletes favourites', () => {
    const h = memory()
    const f = h.saveFavorite({ name: 'Recent', ns: 'db.a', query: q('{ a: 1 }') })
    h.saveFavorite({ id: f.id, name: 'Renamed', ns: 'db.a', query: q('{ a: 2 }') })
    expect(h.listFavorites('db.a')).toMatchObject([{ id: f.id, name: 'Renamed' }])
    h.deleteFavorite(f.id)
    expect(h.listFavorites()).toEqual([])
  })
})

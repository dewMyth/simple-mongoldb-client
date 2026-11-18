import { describe, expect, it, vi } from 'vitest'
import { emptyQueryText } from '../../src/shared/query'
import type { Workspace } from '../../src/shared/workspace'
import { WorkspaceService } from '../../src/main/services/workspace-service'
import { HistoryService, type HistoryData } from '../../src/main/services/history-service'

describe('WorkspaceService (main)', () => {
  const tab = (id: string) => ({
    id,
    type: 'documents' as const,
    connectionId: 'c1',
    ns: 'shop.orders',
    title: 'orders',
    query: emptyQueryText,
    viewMode: 'tree' as const,
    pinned: false,
    scrollAnchor: 0
  })

  it('saves and loads a valid workspace', () => {
    let stored: unknown = null
    const svc = new WorkspaceService({ get: () => stored, set: (v) => (stored = v) })
    const ws: Workspace = { version: 1, tabs: [tab('t1'), tab('t2')], activeId: 't2', split: null }
    svc.save(ws)
    expect(svc.load()).toEqual(ws)
  })

  it('ignores a corrupt file and repairs dangling references', () => {
    expect(new WorkspaceService({ get: () => ({ tabs: 'nope' }), set: () => {} }).load()).toBeNull()
    const ws = new WorkspaceService({
      get: () => ({
        version: 1,
        tabs: [tab('t1')],
        activeId: 'gone',
        split: { tabId: 'gone', orientation: 'horizontal', ratio: 0.5 }
      }),
      set: () => {}
    }).load()
    expect(ws!.activeId).toBe('t1')
    expect(ws!.split).toBeNull()
  })
})

describe('HistoryService.recent', () => {
  it('merges namespaces newest first and filters by connection', () => {
    let data: HistoryData = { history: {}, favorites: [] }
    const h = new HistoryService({ get: () => data, set: (d) => (data = d) })
    const q = (filter: string) => ({ ...emptyQueryText, filter })
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    h.add('c1', 'shop.orders', q('{ a: 1 }'))
    now.mockReturnValue(2000)
    h.add('c2', 'shop.users', q('{ b: 1 }'))
    now.mockReturnValue(3000)
    h.add('c1', 'shop.orders', q('{ c: 1 }'))
    now.mockRestore()
    expect(h.recent(10).map((r) => r.query.filter)).toEqual(['{ c: 1 }', '{ b: 1 }', '{ a: 1 }'])
    expect(h.recent(2)).toHaveLength(2)
    expect(h.recent(10, ['c2']).map((r) => r.ns)).toEqual(['shop.users'])
  })
})

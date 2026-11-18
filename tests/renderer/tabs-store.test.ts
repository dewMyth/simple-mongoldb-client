import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyQueryText } from '../../src/shared/query'

// The tab store fires ops:cancelForTab when tabs close; capture those calls.
const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true, data: 0 }))
vi.stubGlobal('window', { api: { invoke } })
const { focusedTabId, toWorkspace, useTabsStore } = await import('../../src/renderer/src/stores/tabs')

const store = () => useTabsStore.getState()
const docTab = (ns: string, connectionId = 'c1') => ({
  type: 'documents' as const,
  connectionId,
  ns,
  title: ns.split('.')[1]!
})
const titles = () => store().tabs.map((t) => t.title)

beforeEach(() => {
  useTabsStore.setState({ tabs: [], activeId: null, split: null, focusedPane: 'primary', closed: [] })
  invoke.mockClear()
})

describe('tab store', () => {
  it('reuses an identical tab unless a new one is asked for (Cmd/Ctrl+click)', () => {
    const a = store().open(docTab('shop.orders'))
    expect(store().open(docTab('shop.orders'))).toBe(a)
    const b = store().open(docTab('shop.orders'), { newTab: true })
    expect(b).not.toBe(a)
    expect(store().tabs).toHaveLength(2)
    expect(store().activeId).toBe(b)
  })

  it('closing kills the tab’s server operations and picks the next tab', () => {
    const a = store().open(docTab('shop.a'))
    const b = store().open(docTab('shop.b'))
    store().open(docTab('shop.c'))
    store().activate(b)
    store().close(b)
    expect(invoke).toHaveBeenCalledWith('ops:cancelForTab', b)
    expect(titles()).toEqual(['a', 'c'])
    expect(store().tabs.find((t) => t.id === store().activeId)!.title).toBe('c')
    store().close(store().activeId!)
    expect(store().activeId).toBe(a)
  })

  it('reopens closed tabs most recent first, with their query', () => {
    const a = store().open(docTab('shop.a'))
    store().setQuery(a, { ...emptyQueryText, filter: '{ x: 1 }' })
    const b = store().open(docTab('shop.b'))
    store().close(a)
    store().close(b)
    store().reopenClosed()
    expect(titles()).toEqual(['b'])
    store().reopenClosed()
    const reopened = store().tabs.find((t) => t.title === 'a')!
    expect(reopened.query.filter).toBe('{ x: 1 }')
    expect(store().reopenClosed()).toBeNull()
  })

  it('disconnecting closes tabs without adding them to the reopen list', () => {
    store().open(docTab('shop.a', 'c1'))
    store().open(docTab('shop.b', 'c2'))
    store().closeForConnection('c1')
    expect(titles()).toEqual(['b'])
    expect(store().closed).toHaveLength(0)
  })

  it('pins tabs to the front; close others and close-to-the-right keep pinned tabs', () => {
    const a = store().open(docTab('shop.a'))
    const b = store().open(docTab('shop.b'))
    const c = store().open(docTab('shop.c'))
    store().open(docTab('shop.d'))
    store().togglePin(c)
    expect(titles()).toEqual(['c', 'a', 'b', 'd'])
    store().closeToRight(a)
    expect(titles()).toEqual(['c', 'a'])
    store().open(docTab('shop.e'))
    store().closeOthers(a)
    expect(titles()).toEqual(['c', 'a'])
    expect(store().activeId).toBe(a)
    void b
  })

  it('duplicates a tab right after it, with the same query and view', () => {
    const a = store().open(docTab('shop.a'))
    store().setQuery(a, { ...emptyQueryText, filter: '{ y: 2 }' })
    store().setViewMode(a, 'table')
    store().open(docTab('shop.b'))
    const copy = store().duplicate(a)!
    expect(titles()).toEqual(['a', 'a', 'b'])
    const t = store().tabs.find((x) => x.id === copy)!
    expect(t.query.filter).toBe('{ y: 2 }')
    expect(t.viewMode).toBe('table')
    expect(store().activeId).toBe(copy)
  })

  it('split view: the split tab goes to the secondary pane, clicks follow the focused pane', () => {
    const a = store().open(docTab('shop.a'))
    const b = store().open(docTab('shop.b'))
    const c = store().open(docTab('shop.c'))
    store().splitWith(c, 'horizontal')
    expect(store().split).toMatchObject({ tabId: c, orientation: 'horizontal' })
    expect(store().activeId).toBe(b) // the neighbouring tab stays in the primary pane
    expect(focusedTabId(store())).toBe(c)

    // Secondary focused: activating a tab shows it in the secondary pane.
    store().activate(a)
    expect(store().split!.tabId).toBe(a)
    store().focusPane('primary')
    store().activate(c)
    expect(store().activeId).toBe(c)

    // Closing the primary tab promotes the split tab and leaves split view.
    store().close(c)
    expect(store().activeId).toBe(a)
    expect(store().split).toBeNull()
  })

  it('splitting the only tab duplicates it', () => {
    const a = store().open(docTab('shop.a'))
    store().splitWith(a, 'vertical')
    expect(store().tabs).toHaveLength(2)
    expect(store().activeId).toBe(a)
    expect(store().split!.tabId).not.toBe(a)
  })

  it('cycles tabs in order (Ctrl+Tab)', () => {
    const a = store().open(docTab('shop.a'))
    const b = store().open(docTab('shop.b'))
    store().cycle(1)
    expect(store().activeId).toBe(a)
    store().cycle(-1)
    expect(store().activeId).toBe(b)
  })

  it('round-trips through the persisted form; restored tabs do not auto-run', () => {
    const a = store().open(docTab('shop.a'))
    store().setQuery(a, { ...emptyQueryText, filter: '{ z: 3 }' })
    store().setScrollAnchor(a, 12)
    const b = store().open(docTab('shop.b'))
    store().splitWith(b, 'horizontal')
    const ws = toWorkspace(store())
    expect(ws.tabs[0]).not.toHaveProperty('autoRun')

    useTabsStore.setState({ tabs: [], activeId: null, split: null })
    store().hydrate(ws)
    expect(store().tabs.map((t) => t.query.filter)).toEqual(['{ z: 3 }', ''])
    expect(store().tabs.every((t) => !t.autoRun)).toBe(true)
    expect(store().tabs[0]!.scrollAnchor).toBe(12)
    expect(store().split!.tabId).toBe(b)
  })
})

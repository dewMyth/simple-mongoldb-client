/**
 * The tab workspace: open tabs, the active tab, an optional split view, and recently closed tabs.
 * Persisted to disk by stores/workspace-persist.ts (closed tabs and `autoRun` are session-only).
 */
import { create } from 'zustand'
import { emptyQueryText, type QueryText } from '@shared/query'
import type { PersistedTab, SplitOrientation, TabType, ViewMode, Workspace } from '@shared/workspace'
import type { PipelineState } from '@shared/pipeline'
import { ipc } from '../lib/ipc'

export type { TabType, ViewMode, SplitOrientation }

export interface Tab extends PersistedTab {
  /** Run the query when the tab first shows. False for restored tabs: they wait for Find. */
  autoRun: boolean
}

export type NewTab = Pick<Tab, 'type' | 'connectionId' | 'ns' | 'title'> &
  Partial<Pick<Tab, 'query' | 'viewMode' | 'autoRun' | 'pipeline'>>

export interface Split {
  /** The tab shown in the secondary (right/bottom) pane. */
  tabId: string
  orientation: SplitOrientation
  /** Share of the space taken by the primary pane. */
  ratio: number
}

export type Pane = 'primary' | 'secondary'

const CLOSED_LIMIT = 20

/** Kill server-side cursors/ops owned by a tab. Fire-and-forget: closing must never block. */
function releaseTab(id: string) {
  void ipc('ops:cancelForTab', id).catch(() => {})
}

interface TabsState {
  tabs: Tab[]
  /** The tab in the primary pane. */
  activeId: string | null
  split: Split | null
  focusedPane: Pane
  /** Most recently closed first (session only). */
  closed: Tab[]

  open: (tab: NewTab, opts?: { newTab?: boolean }) => string
  close: (id: string) => void
  closeOthers: (id: string) => void
  closeToRight: (id: string) => void
  closeForConnection: (connectionId: string) => void
  reopenClosed: () => string | null
  duplicate: (id: string) => string | null
  togglePin: (id: string) => void
  /** Shows a tab: in the focused pane, or focuses the pane already showing it. */
  activate: (id: string) => void
  /** Cycles through tabs in tab-bar order (Ctrl+Tab). */
  cycle: (direction: 1 | -1) => void
  splitWith: (id: string, orientation: SplitOrientation) => void
  closeSplit: () => void
  setSplitRatio: (ratio: number) => void
  focusPane: (pane: Pane) => void
  setQuery: (id: string, query: QueryText) => void
  setViewMode: (id: string, viewMode: ViewMode) => void
  setScrollAnchor: (id: string, index: number) => void
  setPipeline: (id: string, pipeline: PipelineState) => void
  hydrate: (ws: Workspace) => void
}

let counter = 0
const newId = () => `tab-${Date.now().toString(36)}-${(counter++).toString(36)}`

/** Pinned tabs always come first, keeping their relative order. */
const ordered = (tabs: Tab[]) => [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)]

export const useTabsStore = create<TabsState>((set, get) => {
  /** Removes tabs, keeping the active tab and split valid. */
  const remove = (ids: Set<string>, remember = true) => {
    const { tabs, activeId, split, closed } = get()
    if (!ids.size) return
    for (const id of ids) releaseTab(id)
    const removed = tabs.filter((t) => ids.has(t.id))
    const next = tabs.filter((t) => !ids.has(t.id))
    let newActive = activeId
    let newSplit = split && !ids.has(split.tabId) ? split : null
    if (activeId && ids.has(activeId)) {
      if (newSplit) {
        // The secondary pane's tab takes over the window.
        newActive = newSplit.tabId
        newSplit = null
      } else {
        const idx = tabs.findIndex((t) => t.id === activeId)
        const after = tabs.slice(idx + 1).find((t) => !ids.has(t.id))
        const before = tabs
          .slice(0, idx)
          .reverse()
          .find((t) => !ids.has(t.id))
        newActive = (after ?? before)?.id ?? null
      }
    }
    set({
      tabs: next,
      activeId: newActive,
      split: newSplit,
      focusedPane: newSplit ? get().focusedPane : 'primary',
      closed: remember ? [...removed.reverse(), ...closed].slice(0, CLOSED_LIMIT) : closed
    })
  }

  const insertTab = (tab: Tab, afterId: string | null) => {
    const { tabs } = get()
    const idx = afterId ? tabs.findIndex((t) => t.id === afterId) : -1
    const next = [...tabs]
    next.splice(idx >= 0 ? idx + 1 : next.length, 0, tab)
    return ordered(next)
  }

  const show = (id: string) => {
    const { split, focusedPane, activeId } = get()
    if (split && focusedPane === 'secondary' && id !== activeId) set({ split: { ...split, tabId: id } })
    else if (split && id === split.tabId) set({ focusedPane: 'secondary' })
    else set({ activeId: id, focusedPane: 'primary' })
  }

  return {
    tabs: [],
    activeId: null,
    split: null,
    focusedPane: 'primary',
    closed: [],

    open(tab, opts) {
      const { tabs, activeId, split, focusedPane } = get()
      // Reuse an identical tab unless a new one is requested.
      if (!opts?.newTab) {
        const same = tabs.find(
          (t) => t.type === tab.type && t.connectionId === tab.connectionId && t.ns === tab.ns
        )
        if (same) {
          if (tab.query) get().setQuery(same.id, tab.query)
          show(same.id)
          return same.id
        }
      }
      const id = newId()
      const full: Tab = {
        ...tab,
        id,
        query: tab.query ?? emptyQueryText,
        viewMode: tab.viewMode ?? 'tree',
        pinned: false,
        scrollAnchor: 0,
        autoRun: tab.autoRun ?? true
      }
      const anchor = split && focusedPane === 'secondary' ? split.tabId : activeId
      set({ tabs: insertTab(full, anchor) })
      show(id)
      return id
    },

    close(id) {
      remove(new Set([id]))
    },
    closeOthers(id) {
      remove(
        new Set(
          get()
            .tabs.filter((t) => t.id !== id && !t.pinned)
            .map((t) => t.id)
        )
      )
      show(id)
    },
    closeToRight(id) {
      const { tabs } = get()
      const idx = tabs.findIndex((t) => t.id === id)
      remove(
        new Set(
          tabs
            .slice(idx + 1)
            .filter((t) => !t.pinned)
            .map((t) => t.id)
        )
      )
    },
    closeForConnection(connectionId) {
      // Disconnecting isn't "closing" a tab the user may want back with Cmd+Shift+T.
      remove(
        new Set(
          get()
            .tabs.filter((t) => t.connectionId === connectionId)
            .map((t) => t.id)
        ),
        false
      )
    },

    reopenClosed() {
      const [last, ...rest] = get().closed
      if (!last) return null
      set({ closed: rest })
      const { type, connectionId, ns, title, query, viewMode, pipeline } = last
      return get().open({ type, connectionId, ns, title, query, viewMode, pipeline }, { newTab: true })
    },

    duplicate(id) {
      const src = get().tabs.find((t) => t.id === id)
      if (!src) return null
      const copy: Tab = { ...src, id: newId(), pinned: false, autoRun: true }
      set({ tabs: insertTab(copy, id) })
      show(copy.id)
      return copy.id
    },

    togglePin(id) {
      set({ tabs: ordered(get().tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))) })
    },

    activate: show,

    cycle(direction) {
      const { tabs, activeId, split, focusedPane } = get()
      if (!tabs.length) return
      const current = split && focusedPane === 'secondary' ? split.tabId : activeId
      const idx = tabs.findIndex((t) => t.id === current)
      const next = tabs[(idx + direction + tabs.length) % tabs.length]!
      show(next.id)
    },

    splitWith(id, orientation) {
      const { tabs, activeId, split } = get()
      if (split?.tabId === id) return set({ split: { ...split, orientation }, focusedPane: 'secondary' })
      let primary = activeId
      if (!primary || primary === id) {
        // Keep a neighbouring tab in the primary pane; duplicate if this is the only one.
        const idx = tabs.findIndex((t) => t.id === id)
        primary = (tabs[idx - 1] ?? tabs[idx + 1])?.id ?? null
        if (!primary) {
          const copy = get().duplicate(id)
          primary = id
          id = copy!
        }
      }
      set({
        activeId: primary,
        split: { tabId: id, orientation, ratio: split?.ratio ?? 0.5 },
        focusedPane: 'secondary'
      })
    },
    closeSplit() {
      set({ split: null, focusedPane: 'primary' })
    },
    setSplitRatio(ratio) {
      const split = get().split
      if (split) set({ split: { ...split, ratio: Math.min(0.85, Math.max(0.15, ratio)) } })
    },
    focusPane(pane) {
      if (pane !== get().focusedPane && (pane === 'primary' || get().split)) set({ focusedPane: pane })
    },

    setQuery(id, query) {
      set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, query } : t)) })
    },
    setViewMode(id, viewMode) {
      set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, viewMode } : t)) })
    },
    setScrollAnchor(id, index) {
      const tab = get().tabs.find((t) => t.id === id)
      if (tab && tab.scrollAnchor !== index)
        set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, scrollAnchor: index } : t)) })
    },

    setPipeline(id, pipeline) {
      set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, pipeline } : t)) })
    },

    hydrate(ws) {
      set({
        tabs: ordered(ws.tabs.map((t) => ({ ...t, autoRun: false }))),
        activeId: ws.activeId,
        split: ws.split,
        focusedPane: 'primary',
        closed: []
      })
    }
  }
})

/** The tab in the focused pane (the active tab unless the split pane has focus). */
export function focusedTabId(s: Pick<TabsState, 'activeId' | 'split' | 'focusedPane'>): string | null {
  return s.split && s.focusedPane === 'secondary' ? s.split.tabId : s.activeId
}

/** The persisted form of the current workspace. */
export function toWorkspace(s: Pick<TabsState, 'tabs' | 'activeId' | 'split'>): Workspace {
  return {
    version: 1,
    tabs: s.tabs.map((t) => ({
      id: t.id,
      type: t.type,
      connectionId: t.connectionId,
      ns: t.ns,
      title: t.title,
      query: t.query,
      viewMode: t.viewMode,
      pinned: t.pinned,
      scrollAnchor: t.scrollAnchor,
      ...(t.pipeline ? { pipeline: t.pipeline } : {})
    })),
    activeId: s.activeId,
    split: s.split
  }
}

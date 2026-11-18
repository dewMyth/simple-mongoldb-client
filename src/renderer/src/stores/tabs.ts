import { create } from 'zustand'

export type TabType = 'documents' | 'connection-info'

export interface Tab {
  id: string
  type: TabType
  connectionId: string
  /** "db.collection" for collection tabs; db name only for connection-info. */
  ns: string | null
  title: string
}

interface TabsState {
  tabs: Tab[]
  activeId: string | null
  open: (tab: Omit<Tab, 'id'>, opts?: { newTab?: boolean }) => string
  close: (id: string) => void
  closeForConnection: (connectionId: string) => void
  activate: (id: string) => void
}

let counter = 0
const newId = () => `tab-${Date.now().toString(36)}-${(counter++).toString(36)}`

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  open(tab, opts) {
    const { tabs, activeId } = get()
    // Reuse an identical tab unless a new one is requested.
    if (!opts?.newTab) {
      const same = tabs.find(
        (t) => t.type === tab.type && t.connectionId === tab.connectionId && t.ns === tab.ns
      )
      if (same) {
        set({ activeId: same.id })
        return same.id
      }
    }
    const id = newId()
    const idx = tabs.findIndex((t) => t.id === activeId)
    const next = [...tabs]
    next.splice(idx >= 0 ? idx + 1 : next.length, 0, { ...tab, id })
    set({ tabs: next, activeId: id })
    return id
  },
  close(id) {
    const { tabs, activeId } = get()
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const next = tabs.filter((t) => t.id !== id)
    const newActive = activeId === id ? (next[Math.min(idx, next.length - 1)]?.id ?? null) : activeId
    set({ tabs: next, activeId: newActive })
  },
  closeForConnection(connectionId) {
    const { tabs, activeId } = get()
    const next = tabs.filter((t) => t.connectionId !== connectionId)
    set({ tabs: next, activeId: next.some((t) => t.id === activeId) ? activeId : (next.at(-1)?.id ?? null) })
  },
  activate(id) {
    set({ activeId: id })
  }
}))

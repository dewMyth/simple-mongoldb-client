/**
 * Restores the tab workspace at startup and saves it (debounced) whenever tabs, the active tab
 * or the split view change. Restored tabs keep their queries but don't run until Find.
 */
import { ipc } from '../lib/ipc'
import { queryClient } from '../lib/query-client'
import { keys } from '../features/connections/queries'
import { toWorkspace, useTabsStore } from './tabs'

const SAVE_DELAY = 300
let started = false

export async function initWorkspace(): Promise<void> {
  if (started) return
  started = true
  try {
    const [ws, saved] = await Promise.all([
      ipc('workspace:get'),
      queryClient.fetchQuery({
        queryKey: keys.saved,
        queryFn: () => ipc('connections:list'),
        staleTime: Infinity
      })
    ])
    // Only restore if nothing was opened while loading, and only tabs whose connection still exists.
    if (ws && !useTabsStore.getState().tabs.length) {
      const known = new Set(saved.map((c) => c.id))
      const tabs = ws.tabs.filter((t) => known.has(t.connectionId))
      const ids = new Set(tabs.map((t) => t.id))
      useTabsStore.getState().hydrate({
        ...ws,
        tabs,
        activeId: ws.activeId && ids.has(ws.activeId) ? ws.activeId : (tabs[0]?.id ?? null),
        split: ws.split && ids.has(ws.split.tabId) ? ws.split : null
      })
    }
  } catch {
    /* start with an empty workspace */
  }

  // Save only after the restore, so an empty startup state never overwrites the file.
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    timer = null
    void ipc('workspace:save', toWorkspace(useTabsStore.getState())).catch(() => {})
  }
  useTabsStore.subscribe((s, prev) => {
    if (s.tabs === prev.tabs && s.activeId === prev.activeId && s.split === prev.split) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, SAVE_DELAY)
  })
  window.addEventListener('beforeunload', () => {
    if (!timer) return
    clearTimeout(timer)
    save()
  })
}

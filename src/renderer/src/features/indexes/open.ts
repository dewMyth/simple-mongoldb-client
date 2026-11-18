import type { ExplainSource } from '@shared/explain'
import { useTabsStore } from '../../stores/tabs'

const collName = (ns: string) => ns.slice(ns.indexOf('.') + 1)

/** Opens (or switches to) the Indexes tab of a collection. */
export function openIndexes(connectionId: string, ns: string): string {
  return useTabsStore
    .getState()
    .open({ type: 'indexes', connectionId, ns, title: `${collName(ns)} · indexes` })
}

/** Opens the Explain tab of a collection for this exact query or pipeline, and runs it. */
export function openExplain(connectionId: string, ns: string, source: ExplainSource): string {
  const store = useTabsStore.getState()
  const explain = { source, at: Date.now() }
  const existing = store.tabs.find(
    (t) => t.type === 'explain' && t.connectionId === connectionId && t.ns === ns
  )
  if (existing) {
    store.patch(existing.id, { explain, autoRun: true })
    store.activate(existing.id)
    return existing.id
  }
  return store.open({ type: 'explain', connectionId, ns, title: `${collName(ns)} · explain`, explain })
}

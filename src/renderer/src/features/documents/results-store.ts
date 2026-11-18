/**
 * Per-tab query execution state (not persisted). Documents arrive as canonical EJSON and are
 * deserialized here so every BSON type keeps its class (Int32, Long, Decimal128, …).
 */
import { create } from 'zustand'
import type { Document } from 'bson'
import { fromCanonicalArray } from '@shared/ejson'
import type { CountResult, QueryFieldError, QueryText } from '@shared/query'
import { ipc } from '../../lib/ipc'
import { queryClient } from '../../lib/query-client'

export type RunStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled'

export interface TabResults {
  status: RunStatus
  runId: number
  docs: Document[]
  cursorId: string | null
  exhausted: boolean
  loadingMore: boolean
  error: string | null
  fieldErrors: QueryFieldError[]
  count: CountResult | null
  countError: string | null
  /** Milliseconds from clicking Find to the first batch arriving. */
  firstBatchMs: number | null
  ranQuery: QueryText | null
}

const initial: TabResults = {
  status: 'idle',
  runId: 0,
  docs: [],
  cursorId: null,
  exhausted: true,
  loadingMore: false,
  error: null,
  fieldErrors: [],
  count: null,
  countError: null,
  firstBatchMs: null,
  ranQuery: null
}

export const BATCH_SIZE = 100

interface ResultsState {
  byTab: Record<string, TabResults>
  get: (tabId: string) => TabResults
  run: (args: { tabId: string; connectionId: string; ns: string; query: QueryText }) => Promise<void>
  loadMore: (tabId: string) => Promise<void>
  cancel: (tabId: string) => Promise<void>
  clear: (tabId: string) => void
}

const isCancelled = (e: unknown) => (e as Error)?.name === 'CancelledError'

export const useResultsStore = create<ResultsState>((set, get) => {
  const patch = (tabId: string, p: Partial<TabResults>, runId?: number) => {
    const cur = get().byTab[tabId] ?? initial
    // Ignore late responses from a run that has been superseded.
    if (runId !== undefined && cur.runId !== runId) return
    set({ byTab: { ...get().byTab, [tabId]: { ...cur, ...p } } })
  }

  return {
    byTab: {},
    get: (tabId) => get().byTab[tabId] ?? initial,

    async run({ tabId, connectionId, ns, query }) {
      const prev = get().get(tabId)
      if (prev.status === 'running' || (prev.cursorId && !prev.exhausted)) {
        await ipc('ops:cancelForTab', tabId).catch(() => {})
      }
      const runId = prev.runId + 1
      set({
        byTab: {
          ...get().byTab,
          [tabId]: { ...initial, runId, status: 'running', ranQuery: query }
        }
      })
      const t0 = performance.now()

      // Count in parallel; it never blocks the documents.
      ipc('query:count', { connectionId, ns, tabId, query })
        .then((count) => patch(tabId, { count }, runId))
        .catch((e) => !isCancelled(e) && patch(tabId, { countError: (e as Error).message }, runId))

      try {
        const res = await ipc('query:find', { connectionId, ns, tabId, query, batchSize: BATCH_SIZE })
        if (!res.ok) {
          patch(
            tabId,
            {
              status: 'error',
              fieldErrors: res.errors,
              error: res.errors.map((e) => `${e.field}: ${e.message}`).join('\n')
            },
            runId
          )
          return
        }
        patch(
          tabId,
          {
            status: 'done',
            docs: fromCanonicalArray(res.docs),
            cursorId: res.exhausted ? null : res.cursorId,
            exhausted: res.exhausted,
            firstBatchMs: Math.round(performance.now() - t0)
          },
          runId
        )
        void ipc('history:add', { connectionId, ns, query })
          .then(() => queryClient.invalidateQueries({ queryKey: ['history', connectionId, ns] }))
          .catch(() => {})
      } catch (e) {
        if (isCancelled(e)) patch(tabId, { status: 'cancelled' }, runId)
        else patch(tabId, { status: 'error', error: (e as Error).message }, runId)
      }
    },

    async loadMore(tabId) {
      const cur = get().get(tabId)
      if (!cur.cursorId || cur.exhausted || cur.loadingMore || cur.status !== 'done') return
      const { runId, cursorId } = cur
      patch(tabId, { loadingMore: true }, runId)
      try {
        const page = await ipc('query:getMore', { cursorId, count: BATCH_SIZE })
        const latest = get().get(tabId)
        if (latest.runId !== runId) return
        patch(
          tabId,
          {
            docs: [...latest.docs, ...fromCanonicalArray(page.docs)],
            exhausted: page.exhausted,
            cursorId: page.exhausted ? null : cursorId,
            loadingMore: false
          },
          runId
        )
      } catch (e) {
        patch(
          tabId,
          { loadingMore: false, ...(isCancelled(e) ? {} : { error: (e as Error).message }) },
          runId
        )
      }
    },

    async cancel(tabId) {
      const cur = get().get(tabId)
      if (cur.status !== 'running' && !cur.loadingMore) return
      await ipc('ops:cancelForTab', tabId).catch(() => {})
      patch(tabId, { status: 'cancelled', loadingMore: false, cursorId: null, exhausted: true })
    },

    clear(tabId) {
      const byTab = { ...get().byTab }
      delete byTab[tabId]
      set({ byTab })
    }
  }
})

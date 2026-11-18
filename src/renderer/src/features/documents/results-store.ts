/**
 * Per-tab query execution state (not persisted). Results are paged: each page is its own
 * find() with skip/limit, so no cursor is held open between pages.
 *
 * Documents arrive as canonical EJSON and are deserialized here so every BSON type keeps its
 * class (Int32, Long, Decimal128, …).
 */
import { create } from 'zustand'
import type { Document } from 'bson'
import { fromCanonicalArray } from '@shared/ejson'
import { PAGE_SIZE, type CountResult, type QueryFieldError, type QueryText } from '@shared/query'
import { ipc } from '../../lib/ipc'
import { queryClient } from '../../lib/query-client'

export type RunStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled'

export interface TabResults {
  status: RunStatus
  /** Bumped by every run and page change; stale page responses are ignored. */
  requestId: number
  /** Bumped only by a new run (Find); stale counts are ignored. */
  runId: number
  /** 0-based page index. */
  page: number
  docs: Document[]
  error: string | null
  fieldErrors: QueryFieldError[]
  count: CountResult | null
  countError: string | null
  /** Milliseconds from the request to the page arriving. */
  pageMs: number | null
  /** The query as it was when Find was pressed; paging always uses this one. */
  ranQuery: QueryText | null
  target: { connectionId: string; ns: string } | null
}

const initial: TabResults = {
  status: 'idle',
  requestId: 0,
  runId: 0,
  page: 0,
  docs: [],
  error: null,
  fieldErrors: [],
  count: null,
  countError: null,
  pageMs: null,
  ranQuery: null,
  target: null
}

interface ResultsState {
  byTab: Record<string, TabResults>
  get: (tabId: string) => TabResults
  run: (args: { tabId: string; connectionId: string; ns: string; query: QueryText }) => Promise<void>
  goToPage: (tabId: string, page: number) => Promise<void>
  cancel: (tabId: string) => Promise<void>
  clear: (tabId: string) => void
}

const isCancelled = (e: unknown) => (e as Error)?.name === 'CancelledError'

export const useResultsStore = create<ResultsState>((set, get) => {
  /** Applies `p` only if the guard still holds (i.e. the response isn't stale). */
  const patch = (tabId: string, p: Partial<TabResults>, guard?: (cur: TabResults) => boolean) => {
    const cur = get().byTab[tabId] ?? initial
    if (guard && !guard(cur)) return
    set({ byTab: { ...get().byTab, [tabId]: { ...cur, ...p } } })
  }
  const forRequest = (requestId: number) => (cur: TabResults) => cur.requestId === requestId
  const forRun = (runId: number) => (cur: TabResults) => cur.runId === runId

  /** Fetches one page of the tab's ranQuery. Resolves true on success. */
  async function fetchPage(tabId: string, page: number, requestId: number): Promise<boolean> {
    const cur = get().get(tabId)
    if (!cur.ranQuery || !cur.target) return false
    const t0 = performance.now()
    try {
      const res = await ipc('query:find', {
        ...cur.target,
        tabId,
        query: cur.ranQuery,
        page: { offset: page * PAGE_SIZE, size: PAGE_SIZE }
      })
      if (!res.ok) {
        patch(
          tabId,
          {
            status: 'error',
            fieldErrors: res.errors,
            error: res.errors.map((e) => `${e.field}: ${e.message}`).join('\n')
          },
          forRequest(requestId)
        )
        return false
      }
      patch(
        tabId,
        {
          status: 'done',
          page,
          docs: fromCanonicalArray(res.docs),
          pageMs: Math.round(performance.now() - t0)
        },
        forRequest(requestId)
      )
      return true
    } catch (e) {
      if (isCancelled(e)) patch(tabId, { status: 'cancelled' }, forRequest(requestId))
      else patch(tabId, { status: 'error', error: (e as Error).message }, forRequest(requestId))
      return false
    }
  }

  async function stopRunning(tabId: string) {
    if (get().get(tabId).status === 'running') await ipc('ops:cancelForTab', tabId).catch(() => {})
  }

  return {
    byTab: {},
    get: (tabId) => get().byTab[tabId] ?? initial,

    async run({ tabId, connectionId, ns, query }) {
      await stopRunning(tabId)
      const prev = get().get(tabId)
      const requestId = prev.requestId + 1
      const runId = prev.runId + 1
      set({
        byTab: {
          ...get().byTab,
          [tabId]: {
            ...initial,
            requestId,
            runId,
            status: 'running',
            ranQuery: query,
            target: { connectionId, ns }
          }
        }
      })

      // Count in parallel; it never blocks the documents. Paging doesn't recount.
      ipc('query:count', { connectionId, ns, tabId, query })
        .then((count) => patch(tabId, { count }, forRun(runId)))
        .catch((e) => !isCancelled(e) && patch(tabId, { countError: (e as Error).message }, forRun(runId)))

      if (await fetchPage(tabId, 0, requestId)) {
        void ipc('history:add', { connectionId, ns, query })
          .then(() => queryClient.invalidateQueries({ queryKey: ['history', connectionId, ns] }))
          .catch(() => {})
      }
    },

    async goToPage(tabId, page) {
      const cur = get().get(tabId)
      if (!cur.ranQuery || page < 0 || (page === cur.page && cur.status === 'done')) return
      await stopRunning(tabId)
      const requestId = get().get(tabId).requestId + 1
      // The current page stays visible until the new one arrives.
      patch(tabId, { requestId, status: 'running', error: null })
      await fetchPage(tabId, page, requestId)
    },

    async cancel(tabId) {
      if (get().get(tabId).status !== 'running') return
      await ipc('ops:cancelForTab', tabId).catch(() => {})
      const cur = get().get(tabId)
      patch(tabId, { status: 'cancelled', requestId: cur.requestId + 1 })
    },

    clear(tabId) {
      const byTab = { ...get().byTab }
      delete byTab[tabId]
      set({ byTab })
    }
  }
})

import { useCallback, useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertCircle } from 'lucide-react'
import { toShellString } from '@shared/shell-format'
import type { Tab } from '../../stores/tabs'
import { useTabsStore } from '../../stores/tabs'
import { ErrorBox, Spinner } from '../../components/ui'
import { QueryBar } from '../query-bar/QueryBar'
import { useResultsStore } from './results-store'

export function DocumentsTab({ tab }: { tab: Tab }) {
  const setQuery = useTabsStore((s) => s.setQuery)
  const results = useResultsStore((s) => s.byTab[tab.id]) ?? useResultsStore.getState().get(tab.id)
  const run = useResultsStore((s) => s.run)
  const cancel = useResultsStore((s) => s.cancel)
  const ns = tab.ns!

  const onRun = useCallback(() => {
    const q = useTabsStore.getState().tabs.find((t) => t.id === tab.id)?.query ?? tab.query
    void run({ tabId: tab.id, connectionId: tab.connectionId, ns, query: q })
  }, [run, tab.id, tab.connectionId, ns, tab.query])
  const onCancel = useCallback(() => void cancel(tab.id), [cancel, tab.id])

  // Run once when the tab is first opened (like Compass). Restored tabs (Phase 8) won't auto-run.
  const started = useRef(false)
  useEffect(() => {
    if (!started.current && results.status === 'idle' && results.runId === 0) {
      started.current = true
      onRun()
    }
  }, [onRun, results.status, results.runId])

  // Esc cancels from anywhere in the tab, not just inside the editor.
  useEffect(() => {
    if (results.status !== 'running') return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [results.status, onCancel])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="documents-tab">
      <QueryBar
        connectionId={tab.connectionId}
        ns={ns}
        query={tab.query}
        onChange={(q) => setQuery(tab.id, q)}
        onRun={onRun}
        onCancel={onCancel}
        running={results.status === 'running'}
        fieldErrors={results.fieldErrors}
      />
      <ResultsHeader tabId={tab.id} />
      <ResultsList tabId={tab.id} />
    </div>
  )
}

function ResultsHeader({ tabId }: { tabId: string }) {
  const r = useResultsStore((s) => s.byTab[tabId])
  if (!r) return null
  const loaded = r.docs.length
  let countText = ''
  if (r.count) {
    const total = r.count.exact ? r.count.value : Math.max(r.count.value, loaded)
    countText = r.count.exact
      ? `${total.toLocaleString()} document${total === 1 ? '' : 's'}`
      : `≥ ${total.toLocaleString()} documents`
  } else if (r.countError) {
    countText = 'Count unavailable'
  } else if (r.status !== 'idle') {
    countText = 'Counting…'
  }
  return (
    <div
      className="flex h-8 shrink-0 items-center justify-between border-b border-border px-3 text-xs text-muted"
      data-testid="results-header"
    >
      <span className="flex items-center gap-2">
        {r.status === 'running' && (
          <>
            <Spinner size={11} /> Running… <span className="text-muted/70">(Esc to cancel)</span>
          </>
        )}
        {r.status === 'cancelled' && <span className="text-warn">Query cancelled</span>}
        {(r.status === 'done' || r.status === 'cancelled') && loaded > 0 && (
          <span data-testid="loaded-count">
            Showing {loaded.toLocaleString()}
            {r.exhausted ? '' : '+'}
          </span>
        )}
      </span>
      <span className="flex items-center gap-3">
        <span data-testid="result-count" title={r.countError ?? undefined}>
          {countText}
        </span>
        {r.firstBatchMs !== null && <span title="Time to first batch">{r.firstBatchMs} ms</span>}
      </span>
    </div>
  )
}

/** Minimal virtualized list (Phase 5 replaces this with List / JSON / Table views). */
function ResultsList({ tabId }: { tabId: string }) {
  const r = useResultsStore((s) => s.byTab[tabId])
  const loadMore = useResultsStore((s) => s.loadMore)
  const parentRef = useRef<HTMLDivElement>(null)
  const docs = r?.docs ?? []
  const virtualizer = useVirtualizer({
    count: docs.length + (r && !r.exhausted ? 1 : 0),
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160,
    overscan: 6
  })
  const items = virtualizer.getVirtualItems()
  const last = items.at(-1)

  useEffect(() => {
    if (last && last.index >= docs.length - 10) void loadMore(tabId)
  }, [last, docs.length, loadMore, tabId])

  if (!r) return null
  if (r.status === 'error' && r.error) {
    return (
      <div className="p-4">
        <ErrorBox>
          <span className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-px shrink-0" />
            <span className="whitespace-pre-wrap">{r.error}</span>
          </span>
        </ErrorBox>
      </div>
    )
  }
  if (r.status === 'done' && !docs.length) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted">
        No documents match this query.
      </div>
    )
  }

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto" data-testid="results-list">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute inset-x-0 px-3 pt-2"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {item.index < docs.length ? (
              <pre
                className="selectable overflow-hidden rounded-md border border-border bg-panel px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre-wrap"
                data-testid="doc"
              >
                {toShellString(docs[item.index])}
              </pre>
            ) : (
              <div className="flex h-10 items-center justify-center gap-2 text-xs text-muted">
                <Spinner size={11} /> Loading more…
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Braces, ChevronsDownUp, ChevronsUpDown, ListTree } from 'lucide-react'
import { toShellString } from '@shared/shell-format'
import type { Tab, ViewMode } from '../../stores/tabs'
import { useTabsStore } from '../../stores/tabs'
import { ErrorBox, Spinner } from '../../components/form'
import { QueryBar } from '../query-bar/QueryBar'
import { Button } from '../../components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group'
import { useResultsStore } from './results-store'
import { JsonTree, type ExpandMode } from './JsonTree'

interface ExpandRequest {
  epoch: number
  mode: ExpandMode
}

export function DocumentsTab({ tab }: { tab: Tab }) {
  const setQuery = useTabsStore((s) => s.setQuery)
  const setViewMode = useTabsStore((s) => s.setViewMode)
  const [expand, setExpand] = useState<ExpandRequest>({ epoch: 0, mode: 'default' })
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
      <ResultsHeader
        tabId={tab.id}
        viewMode={tab.viewMode}
        onViewMode={(m) => setViewMode(tab.id, m)}
        expand={expand}
        onExpand={(mode) => setExpand((e) => ({ epoch: e.epoch + 1, mode }))}
      />
      <ResultsList tabId={tab.id} viewMode={tab.viewMode} expand={expand} />
    </div>
  )
}

function ResultsHeader({
  tabId,
  viewMode,
  onViewMode,
  expand,
  onExpand
}: {
  tabId: string
  viewMode: ViewMode
  onViewMode: (m: ViewMode) => void
  expand: ExpandRequest
  onExpand: (mode: ExpandMode) => void
}) {
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
      className="flex h-8 shrink-0 items-center justify-between border-b border-border px-3 text-xs text-muted-foreground"
      data-testid="results-header"
    >
      <span className="flex items-center gap-2">
        {r.status === 'running' && (
          <>
            <Spinner className="size-3" /> Running…{' '}
            <span className="text-muted-foreground/70">(Esc to cancel)</span>
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
        {viewMode === 'tree' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-muted-foreground"
            onClick={() => onExpand(expand.mode === 'all' ? 'default' : 'all')}
            data-testid="expand-all"
          >
            {expand.mode === 'all' ? <ChevronsDownUp /> : <ChevronsUpDown />}
            {expand.mode === 'all' ? 'Collapse all' : 'Expand all'}
          </Button>
        )}
        <span data-testid="result-count" title={r.countError ?? undefined}>
          {countText}
        </span>
        {r.firstBatchMs !== null && <span title="Time to first batch">{r.firstBatchMs} ms</span>}
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={viewMode}
          onValueChange={(v) => v && onViewMode(v as ViewMode)}
          aria-label="Result view"
        >
          <ToggleGroupItem
            value="tree"
            aria-label="Tree view"
            title="Tree view"
            className="h-6 px-2"
            data-testid="view-tree"
          >
            <ListTree />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="text"
            aria-label="Text view"
            title="Text view (shell syntax)"
            className="h-6 px-2"
            data-testid="view-text"
          >
            <Braces />
          </ToggleGroupItem>
        </ToggleGroup>
      </span>
    </div>
  )
}

/** Virtualized results; each row is a tree or a shell-syntax text block. */
function ResultsList({
  tabId,
  viewMode,
  expand
}: {
  tabId: string
  viewMode: ViewMode
  expand: ExpandRequest
}) {
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
        <ErrorBox>{r.error}</ErrorBox>
      </div>
    )
  }
  if (r.status === 'done' && !docs.length) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
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
            {item.index < docs.length && viewMode === 'tree' ? (
              <JsonTree doc={docs[item.index]!} epoch={expand.epoch} mode={expand.mode} />
            ) : item.index < docs.length ? (
              <pre
                className="selectable overflow-hidden rounded-md border bg-card px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre-wrap"
                data-testid="doc"
              >
                {toShellString(docs[item.index])}
              </pre>
            ) : (
              <div className="flex h-10 items-center justify-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3" /> Loading more…
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

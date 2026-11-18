import { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Braces,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  ListTree
} from 'lucide-react'
import { PAGE_SIZE, resultTotal } from '@shared/query'
import { cn } from '@renderer/lib/utils'
import { toShellString } from '@shared/shell-format'
import type { Tab, ViewMode } from '../../stores/tabs'
import { useTabsStore } from '../../stores/tabs'
import { ErrorBox, Spinner } from '../../components/form'
import { QueryBar } from '../query-bar/QueryBar'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group'
import { useResultsStore, type TabResults } from './results-store'
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

/** User skip/limit from the query that produced the current results. */
function userWindow(r: TabResults): { skip?: number; limit?: number } {
  return {
    skip: Number(r.ranQuery?.skip.trim() || 0) || undefined,
    limit: Number(r.ranQuery?.limit.trim() || 0) || undefined
  }
}

/** Total documents in the result set, if known exactly. */
function exactTotal(r: TabResults): number | null {
  return r.count?.exact ? resultTotal(r.count.value, userWindow(r)) : null
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
  let countText = ''
  if (r.count) {
    const total = resultTotal(r.count.value, userWindow(r))
    countText = r.count.exact
      ? `${total.toLocaleString()} document${total === 1 ? '' : 's'}`
      : `≥ ${Math.max(total, r.page * PAGE_SIZE + r.docs.length).toLocaleString()} documents`
  } else if (r.countError) {
    countText = 'Count unavailable'
  } else if (r.status !== 'idle') {
    countText = 'Counting…'
  }
  return (
    <div
      className="flex h-9 shrink-0 items-center justify-between gap-3 border-b px-3 text-xs text-muted-foreground"
      data-testid="results-header"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Pager tabId={tabId} r={r} />
        {r.status === 'running' && (
          <>
            <Spinner className="size-3" /> Running…{' '}
            <span className="text-muted-foreground/70">(Esc to cancel)</span>
          </>
        )}
        {r.status === 'cancelled' && <span className="text-warn">Query cancelled</span>}
      </span>
      <span className="flex shrink-0 items-center gap-3">
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
        {r.pageMs !== null && <span title="Time to load this page">{r.pageMs} ms</span>}
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

/** First / previous / page input / next / last, plus the "26–50" range. 25 documents per page. */
function Pager({ tabId, r }: { tabId: string; r: TabResults }) {
  const goToPage = useResultsStore((s) => s.goToPage)
  const [draft, setDraft] = useState<string | null>(null)
  if (!r.ranQuery || (r.status !== 'done' && r.docs.length === 0 && r.page === 0)) return null

  const total = exactTotal(r)
  const lastPage = total !== null ? Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) : null
  const hasNext = lastPage !== null ? r.page < lastPage : r.docs.length === PAGE_SIZE
  const busy = r.status === 'running'
  const from = r.docs.length ? r.page * PAGE_SIZE + 1 : 0
  const to = r.page * PAGE_SIZE + r.docs.length

  const go = (p: number) =>
    void goToPage(tabId, lastPage !== null ? Math.min(Math.max(0, p), lastPage) : Math.max(0, p))
  const submit = () => {
    const n = Number(draft)
    setDraft(null)
    if (Number.isInteger(n) && n >= 1) go(n - 1)
  }

  return (
    <span className="flex items-center gap-0.5" data-testid="pager">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="First page"
        disabled={busy || r.page === 0}
        onClick={() => go(0)}
        data-testid="page-first"
      >
        <ChevronsLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous page"
        disabled={busy || r.page === 0}
        onClick={() => go(r.page - 1)}
        data-testid="page-prev"
      >
        <ChevronLeft />
      </Button>
      <span className="flex items-center gap-1 px-1">
        Page
        <Input
          aria-label="Page number"
          inputMode="numeric"
          className="h-6 w-11 px-1.5 text-center text-xs"
          value={draft ?? String(r.page + 1)}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
          onFocus={(e) => e.target.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') setDraft(null)
          }}
          data-testid="page-input"
        />
        {lastPage !== null && <span>of {(lastPage + 1).toLocaleString()}</span>}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next page"
        disabled={busy || !hasNext}
        onClick={() => go(r.page + 1)}
        data-testid="page-next"
      >
        <ChevronRight />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Last page"
        disabled={busy || lastPage === null || r.page >= lastPage}
        onClick={() => lastPage !== null && go(lastPage)}
        data-testid="page-last"
      >
        <ChevronsRight />
      </Button>
      <span className="pl-1.5 tabular-nums" data-testid="page-range">
        {from.toLocaleString()}–{to.toLocaleString()}
      </span>
    </span>
  )
}

/** Virtualized page of results; each row is a tree or a shell-syntax text block. */
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
  const parentRef = useRef<HTMLDivElement>(null)
  const docs = r?.docs ?? []
  const virtualizer = useVirtualizer({
    count: docs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160,
    overscan: 4
  })

  // A new page starts at the top (r.docs only changes identity when a page arrives).
  const pageDocs = r?.docs
  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 })
  }, [pageDocs])

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
        {r.page > 0 ? 'No documents on this page.' : 'No documents match this query.'}
      </div>
    )
  }

  return (
    <div
      ref={parentRef}
      className={cn(
        'min-h-0 flex-1 overflow-auto pb-2 transition-opacity',
        r.status === 'running' && docs.length > 0 && 'opacity-60'
      )}
      data-testid="results-list"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute inset-x-0 px-3 pt-2"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {viewMode === 'tree' ? (
              <JsonTree doc={docs[item.index]!} epoch={expand.epoch} mode={expand.mode} />
            ) : (
              <pre
                className="selectable overflow-hidden rounded-md border bg-card px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre-wrap"
                data-testid="doc"
              >
                {toShellString(docs[item.index])}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

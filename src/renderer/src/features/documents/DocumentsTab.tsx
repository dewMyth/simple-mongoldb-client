import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Document } from 'bson'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Braces,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  ListTree,
  MoreHorizontal,
  Plus,
  ChartColumn,
  KeyRound,
  Sheet,
  Workflow
} from 'lucide-react'
import { PAGE_SIZE, resultTotal } from '@shared/query'
import { toShellString } from '@shared/shell-format'
import { cn } from '@renderer/lib/utils'
import type { Tab, ViewMode } from '../../stores/tabs'
import { focusedTabId, useTabsStore } from '../../stores/tabs'
import { ErrorBox, Spinner } from '../../components/form'
import { QueryBar } from '../query-bar/QueryBar'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group'
import { useResultsStore, type TabResults } from './results-store'
import { JsonTree, type ExpandMode } from './JsonTree'
import { JsonView } from './JsonView'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { TableView } from './TableView'
import { PermissionsPanel } from '../permissions/PermissionsPanel'
import { useCollections } from '../connections/queries'
import { Dialog } from '../../components/Dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../../components/ui/dropdown-menu'
import { ReasonText } from '../../components/ReasonText'
import { DocsContext, type DocsTarget } from './docs-context'
import { DocActions } from './editing/DocActions'
import { DocEditCard, type EditMode } from './editing/DocEditCard'
import { EMPTY_INSERT, InsertDialog } from './editing/InsertDialog'
import { BulkDeleteDialog, BulkUpdateDialog } from './editing/BulkDialogs'
import { useWriteCheck } from './editing/use-write-check'
import { openAggregation } from '../aggregation/open'
import { openIndexes } from '../indexes/open'
import { openSchema } from '../schema/open'
import { useDialogStore } from '../../stores/dialogs'

/** The document being edited, tied to the page request it belongs to. */
interface Editing {
  index: number
  mode: EditMode
  requestId: number
}

interface EditingProps {
  editing: Editing | null
  onEdit: (index: number, mode: EditMode) => void
  onDoneEditing: () => void
  onClone: (doc: Document) => void
}

interface ExpandRequest {
  epoch: number
  mode: ExpandMode
}

export function DocumentsTab({ tab }: { tab: Tab }) {
  const setQuery = useTabsStore((s) => s.setQuery)
  const setViewMode = useTabsStore((s) => s.setViewMode)
  const openDialog = useDialogStore((s) => s.open)
  const [expand, setExpand] = useState<ExpandRequest>({ epoch: 0, mode: 'default' })
  const results = useResultsStore((s) => s.byTab[tab.id]) ?? useResultsStore.getState().get(tab.id)
  const run = useResultsStore((s) => s.run)
  const cancel = useResultsStore((s) => s.cancel)
  const ns = tab.ns!
  const db = ns.slice(0, ns.indexOf('.'))
  const collName = ns.slice(ns.indexOf('.') + 1)
  const { data: colls } = useCollections(tab.connectionId, db, true)
  const isView = colls?.find((c) => c.name === collName)?.type === 'view'
  const target = useMemo<DocsTarget>(
    () => ({
      tabId: tab.id,
      connectionId: tab.connectionId,
      ns,
      readOnlyReason: isView ? 'Views are read-only.' : null
    }),
    [tab.id, tab.connectionId, ns, isView]
  )
  const [editingState, setEditing] = useState<Editing | null>(null)
  // Editing belongs to one page request: paging or re-running the query ends it.
  const editing = editingState?.requestId === results.requestId ? editingState : null
  const [inserting, setInserting] = useState<string | null>(null)
  const [bulk, setBulk] = useState<'update' | 'delete' | null>(null)
  const editingProps: EditingProps = {
    editing,
    onEdit: (index, mode) => setEditing({ index, mode, requestId: results.requestId }),
    onDoneEditing: () => setEditing(null),
    onClone: (doc) => {
      const copy = { ...doc }
      delete copy['_id']
      setInserting(toShellString(copy))
    }
  }

  const onRun = useCallback(() => {
    const q = useTabsStore.getState().tabs.find((t) => t.id === tab.id)?.query ?? tab.query
    void run({ tabId: tab.id, connectionId: tab.connectionId, ns, query: q })
  }, [run, tab.id, tab.connectionId, ns, tab.query])
  const onCancel = useCallback(() => void cancel(tab.id), [cancel, tab.id])

  // Run once when the tab is first opened (like Compass). Restored tabs wait for Find.
  const started = useRef(false)
  useEffect(() => {
    if (!started.current && results.status === 'idle' && results.runId === 0) {
      started.current = true
      if (tab.autoRun) onRun()
    }
  }, [onRun, results.status, results.runId, tab.autoRun])

  // Esc cancels from anywhere in the tab, not just inside the editor.
  useEffect(() => {
    if (results.status !== 'running') return
    // With a split view, only the focused pane's query is cancelled.
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && focusedTabId(useTabsStore.getState()) === tab.id && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [results.status, onCancel, tab.id])

  return (
    <DocsContext.Provider value={target}>
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
          onInsert={() => setInserting(EMPTY_INSERT)}
          onAggregate={() => openAggregation(tab.connectionId, ns, tab.query.filter)}
          onIndexes={() => openIndexes(tab.connectionId, ns)}
          onSchema={() => openSchema(tab.connectionId, ns, tab.query.filter)}
          onExport={() =>
            openDialog({
              kind: 'export',
              connectionId: tab.connectionId,
              ns,
              query: results.ranQuery ?? tab.query
            })
          }
          onImport={() => openDialog({ kind: 'import', connectionId: tab.connectionId, ns })}
          onBulk={setBulk}
        />
        <ResultsList tabId={tab.id} viewMode={tab.viewMode} expand={expand} {...editingProps} />
        {inserting !== null && <InsertDialog initialText={inserting} onClose={() => setInserting(null)} />}
        {bulk === 'update' && results.ranQuery && (
          <BulkUpdateDialog query={results.ranQuery} onClose={() => setBulk(null)} />
        )}
        {bulk === 'delete' && results.ranQuery && (
          <BulkDeleteDialog query={results.ranQuery} onClose={() => setBulk(null)} />
        )}
      </div>
    </DocsContext.Provider>
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
  onExpand,
  onInsert,
  onAggregate,
  onIndexes,
  onSchema,
  onExport,
  onImport,
  onBulk
}: {
  tabId: string
  viewMode: ViewMode
  onViewMode: (m: ViewMode) => void
  expand: ExpandRequest
  onExpand: (mode: ExpandMode) => void
  onInsert: () => void
  onAggregate: () => void
  onIndexes: () => void
  onSchema: () => void
  onExport: () => void
  onImport: () => void
  onBulk: (kind: 'update' | 'delete') => void
}) {
  const r = useResultsStore((s) => s.byTab[tabId])
  const canInsert = useWriteCheck('insert')
  const canUpdate = useWriteCheck('update')
  const canRemove = useWriteCheck('remove')
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
      // A container: in a narrow pane (split view, small window) the buttons drop their labels, and
      // as a last resort the row wraps, so nothing overlaps the pager.
      className="@container/results flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1 text-xs text-muted-foreground"
      data-testid="results-header"
    >
      <span className="flex shrink-0 items-center gap-2">
        <Pager tabId={tabId} r={r} />
        {r.status === 'running' && (
          <>
            <Spinner className="size-3" /> Running…{' '}
            <span className="text-muted-foreground/70">(Esc to cancel)</span>
          </>
        )}
        {r.status === 'cancelled' && <span className="text-warn">Query cancelled</span>}
      </span>
      <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
        {viewMode === 'tree' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-muted-foreground"
            onClick={() => onExpand(expand.mode === 'all' ? 'default' : 'all')}
            aria-label={expand.mode === 'all' ? 'Collapse all' : 'Expand all'}
            title={expand.mode === 'all' ? 'Collapse all' : 'Expand all'}
            data-testid="expand-all"
          >
            {expand.mode === 'all' ? <ChevronsDownUp /> : <ChevronsUpDown />}
            <Label>{expand.mode === 'all' ? 'Collapse all' : 'Expand all'}</Label>
          </Button>
        )}
        <span data-testid="result-count" title={r.countError ?? undefined}>
          {countText}
        </span>
        {r.pageMs !== null && (
          <span className="hidden @3xl/results:inline" title="Time to load this page">
            {r.pageMs} ms
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6"
          title="Open the aggregation builder (starts with this filter)"
          onClick={onAggregate}
          aria-label="Aggregate"
          data-testid="open-aggregation"
        >
          <Workflow /> <Label>Aggregate</Label>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6"
          title="Indexes of this collection"
          onClick={onIndexes}
          aria-label="Indexes"
          data-testid="open-indexes"
        >
          <KeyRound /> <Label>Indexes</Label>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6"
          title="Schema analysis of this collection"
          onClick={onSchema}
          aria-label="Schema"
          data-testid="open-schema"
        >
          <ChartColumn /> <Label>Schema</Label>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6"
          disabled={!canInsert.allowed}
          title={canInsert.allowed ? 'Insert documents' : `Insert: ${canInsert.reason}`}
          onClick={onInsert}
          data-testid="insert-button"
        >
          <Plus /> Insert
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions" data-testid="more-actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72 text-xs">
            <DropdownMenuItem onSelect={onExport} data-testid="menu-export">
              Export…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onImport}
              disabled={!canInsert.allowed}
              className="flex-col items-start gap-0"
              data-testid="menu-import"
            >
              Import…
              {!canInsert.allowed && canInsert.reason && (
                <span className="text-[11px] text-muted-foreground">
                  <ReasonText text={canInsert.reason} />
                </span>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {(
              [
                ['update', 'Update matching documents…', canUpdate],
                ['delete', 'Delete matching documents…', canRemove]
              ] as const
            ).map(([kind, text, check]) => (
              <DropdownMenuItem
                key={kind}
                disabled={!check.allowed || !r.ranQuery}
                // Open after the menu has closed: a dialog opened mid-close loses keyboard input to
                // the menu's focus handling (Radix).
                onSelect={() => setTimeout(() => onBulk(kind), 0)}
                variant={kind === 'delete' ? 'destructive' : 'default'}
                className="flex-col items-start gap-0"
                data-testid={`bulk-${kind}`}
              >
                {text}
                {!check.allowed && check.reason && (
                  <span className="text-[11px] text-muted-foreground">
                    <ReasonText text={check.reason} />
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {r.target && <PermissionsPanel connectionId={r.target.connectionId} ns={r.target.ns} />}
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
            value="json"
            aria-label="JSON view"
            title="JSON view (shell syntax)"
            className="h-6 px-2"
            data-testid="view-json"
          >
            <Braces />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="table"
            aria-label="Table view"
            title="Table view"
            className="h-6 px-2"
            data-testid="view-table"
          >
            <Sheet />
          </ToggleGroupItem>
        </ToggleGroup>
      </span>
    </div>
  )
}

/** First / previous / page input / next / last, plus the "26–50" range. 25 documents per page. */
/** A toolbar button label that hides in a narrow results pane (the icon and title remain). */
function Label({ children }: { children: ReactNode }) {
  return <span className="hidden @6xl/results:inline">{children}</span>
}

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
  expand,
  editing,
  onEdit,
  onDoneEditing,
  onClone
}: {
  tabId: string
  viewMode: ViewMode
  expand: ExpandRequest
} & EditingProps) {
  const updateCheck = useWriteCheck('update')
  const r = useResultsStore((s) => s.byTab[tabId])
  const autoRun = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.autoRun ?? true)
  const parentRef = useRef<HTMLDivElement>(null)
  const docs = r?.docs ?? []
  const virtualizer = useVirtualizer({
    count: docs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160,
    overscan: 4
  })

  // A new page starts at the top (r.docs only changes identity when a page arrives), except
  // when the tab is shown again: then it returns to the document it was scrolled to.
  const pageDocs = r?.docs
  const restoredScroll = useRef(false)
  useEffect(() => {
    const anchor = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.scrollAnchor ?? 0
    if (!restoredScroll.current && pageDocs?.length) {
      restoredScroll.current = true
      if (anchor > 0 && anchor < pageDocs.length) {
        virtualizer.scrollToIndex(anchor, { align: 'start' })
        return
      }
    }
    parentRef.current?.scrollTo({ top: 0 })
  }, [pageDocs, tabId, virtualizer])

  // Remember the first visible document (debounced) so switching tabs keeps the place.
  const anchorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (anchorTimer.current && clearTimeout(anchorTimer.current)), [])
  const onScroll = () => {
    if (anchorTimer.current) clearTimeout(anchorTimer.current)
    anchorTimer.current = setTimeout(() => {
      const top = parentRef.current?.scrollTop ?? 0
      const first = virtualizer.getVirtualItems().find((i) => i.end > top)
      useTabsStore.getState().setScrollAnchor(tabId, first?.index ?? 0)
    }, 150)
  }

  // Performance instrumentation (read by scripts/bench-ui.ts): once the page has been painted,
  // record query time (request → data) and render time (data → pixels) as a measure.
  const receivedAt = r?.receivedAt
  const requestedAt = r?.requestedAt
  useEffect(() => {
    if (!pageDocs?.length || receivedAt == null || requestedAt == null) return
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const paintedAt = performance.now()
        performance.measure('ms:page', {
          start: requestedAt,
          end: paintedAt,
          detail: {
            viewMode,
            docs: pageDocs.length,
            queryMs: receivedAt - requestedAt,
            renderMs: paintedAt - receivedAt
          }
        })
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [pageDocs, receivedAt, requestedAt, viewMode])

  if (!r || (r.status === 'idle' && r.runId === 0)) {
    if (autoRun) return null // about to run
    return (
      <div
        className="flex flex-1 items-center justify-center text-xs text-muted-foreground"
        data-testid="restored-hint"
      >
        Press Find (⌘↵) to run this query.
      </div>
    )
  }
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

  const loading = r.status === 'running' && docs.length > 0
  if (viewMode === 'table' && r.target) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col transition-opacity', loading && 'opacity-60')}>
        <ErrorBoundary label="the table">
          <TableView
            docs={docs}
            offset={r.page * PAGE_SIZE}
            connectionId={r.target.connectionId}
            ns={r.target.ns}
            tabId={tabId}
            onEdit={(i) => onEdit(i, 'inline')}
            editCheck={updateCheck}
          />
        </ErrorBoundary>
        {editing && docs[editing.index] && (
          <Dialog open onOpenChange={(o) => !o && onDoneEditing()} width="lg" title="Edit document">
            <DocEditCard
              index={editing.index}
              doc={docs[editing.index]!}
              raw={r.raw[editing.index]!}
              mode={editing.mode}
              onDone={onDoneEditing}
            />
          </Dialog>
        )}
      </div>
    )
  }

  return (
    <div
      ref={parentRef}
      onScroll={onScroll}
      className={cn('min-h-0 flex-1 overflow-auto pb-2 transition-opacity', loading && 'opacity-60')}
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
            <ErrorBoundary label="this document">
              {editing?.index === item.index ? (
                <DocEditCard
                  index={item.index}
                  doc={docs[item.index]!}
                  raw={r.raw[item.index]!}
                  mode={editing.mode}
                  onDone={onDoneEditing}
                />
              ) : viewMode === 'tree' ? (
                <JsonTree
                  doc={docs[item.index]!}
                  epoch={expand.epoch}
                  mode={expand.mode}
                  actions={
                    <DocActions
                      doc={docs[item.index]!}
                      index={item.index}
                      onEdit={(m) => onEdit(item.index, m)}
                      onClone={onClone}
                    />
                  }
                />
              ) : (
                <JsonView
                  doc={docs[item.index]!}
                  actions={
                    <DocActions
                      doc={docs[item.index]!}
                      index={item.index}
                      onEdit={(m) => onEdit(item.index, m)}
                      onClone={onClone}
                    />
                  }
                />
              )}
            </ErrorBoundary>
          </div>
        ))}
      </div>
    </div>
  )
}

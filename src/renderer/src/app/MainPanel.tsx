import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { Database, PlugZap, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useTabsStore, type Pane, type Tab } from '../stores/tabs'
import { ConnectionInfoPanel } from '../features/connections/ConnectionInfoPanel'
import { DocumentsTab } from '../features/documents/DocumentsTab'
import { useActiveConnections, useConnect, useSavedConnections } from '../features/connections/queries'
import { Button } from '../components/ui/button'
import { ErrorBox } from '../components/form'

/** Tab types that later phases implement; shown as a placeholder until then. */
const upcoming: Partial<Record<Tab['type'], string>> = {
  aggregation: 'Aggregation builder',
  indexes: 'Indexes',
  schema: 'Schema',
  explain: 'Explain plan',
  shell: 'Shell',
  'import-export': 'Import / Export'
}

export function MainPanel() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId))
  const split = useTabsStore((s) => s.split)
  const second = useTabsStore((s) => (s.split ? s.tabs.find((t) => t.id === s.split!.tabId) : undefined))
  const setRatio = useTabsStore((s) => s.setSplitRatio)
  const containerRef = useRef<HTMLDivElement>(null)

  if (!tab) {
    return (
      <main className="flex min-h-0 flex-1 flex-col" data-testid="main-panel">
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Database size={40} strokeWidth={1.2} />
            <h1 className="text-lg font-medium text-foreground">Mongo Studio</h1>
            <p className="text-xs">
              Connect, then pick a collection from the sidebar. {modKey}K opens the palette.
            </p>
          </div>
        </div>
      </main>
    )
  }

  if (!split || !second) {
    return (
      <main className="flex min-h-0 flex-1 flex-col" data-testid="main-panel">
        <PaneView tab={tab} pane="primary" split={false} />
      </main>
    )
  }

  const horizontal = split.orientation === 'horizontal'
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = containerRef.current?.getBoundingClientRect()
    if (!box) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) =>
      setRatio(horizontal ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <main
      ref={containerRef}
      className={cn('flex min-h-0 min-w-0 flex-1', horizontal ? 'flex-row' : 'flex-col')}
      data-testid="main-panel"
      data-split={split.orientation}
    >
      <div className="flex min-h-0 min-w-0 flex-col" style={{ flex: `${split.ratio} 1 0` }}>
        <PaneView tab={tab} pane="primary" split />
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        onPointerDown={startDrag}
        className={cn(
          'shrink-0 bg-border hover:bg-primary/50',
          horizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
        )}
        data-testid="split-divider"
      />
      <div className="flex min-h-0 min-w-0 flex-col" style={{ flex: `${1 - split.ratio} 1 0` }}>
        <PaneView tab={second} pane="secondary" split />
      </div>
    </main>
  )
}

const modKey = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'

function PaneView({ tab, pane, split }: { tab: Tab; pane: Pane; split: boolean }) {
  const focused = useTabsStore((s) => s.focusedPane === pane)
  const focusPane = useTabsStore((s) => s.focusPane)
  const closeSplit = useTabsStore((s) => s.closeSplit)
  const { data: saved = [] } = useSavedConnections()
  const { data: active } = useActiveConnections()
  const conn = saved.find((c) => c.id === tab.connectionId)
  const connected = active?.some((a) => a.id === tab.connectionId)

  return (
    <section
      className={cn(
        'relative flex min-h-0 flex-1 flex-col',
        conn?.production && 'ring-2 ring-destructive/70 ring-inset',
        split && focused && !conn?.production && 'ring-1 ring-primary/40 ring-inset'
      )}
      onPointerDownCapture={() => focusPane(pane)}
      data-testid={`pane-${pane}`}
      data-tab-id={tab.id}
      data-production={conn?.production || undefined}
    >
      {split && (
        <div className="flex h-6 shrink-0 items-center gap-2 border-b bg-panel px-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {conn?.name} · {tab.ns ?? tab.title}
          </span>
          {pane === 'secondary' && (
            <button
              type="button"
              className="rounded p-0.5 hover:bg-panel-2"
              aria-label="Close split view"
              onClick={closeSplit}
              data-testid="close-split"
            >
              <X size={11} />
            </button>
          )}
        </div>
      )}
      {active === undefined ? null : !connected ? (
        <Reconnect tab={tab} name={conn?.name ?? 'this connection'} />
      ) : tab.type === 'connection-info' ? (
        <ConnectionInfoPanel connectionId={tab.connectionId} />
      ) : tab.type === 'documents' ? (
        <DocumentsTab key={tab.id} tab={tab} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {upcoming[tab.type] ?? tab.type} isn’t available yet.
        </div>
      )}
    </section>
  )
}

/** A restored tab whose connection isn't open yet: its query is kept and runs only on Find. */
function Reconnect({ tab, name }: { tab: Tab; name: string }) {
  const connect = useConnect()
  return (
    <div className="flex flex-1 items-center justify-center p-6" data-testid="reconnect-tab">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <PlugZap size={32} strokeWidth={1.3} className="text-muted-foreground" />
        <div className="text-sm font-medium">{tab.ns ?? tab.title}</div>
        <p className="text-xs text-muted-foreground">
          {name} isn’t connected. Connect to continue; the query is kept and runs when you press Find.
        </p>
        {tab.query.filter.trim() && (
          <pre className="max-w-full truncate rounded bg-panel-2 px-2 py-1 font-mono text-[11px]">
            {tab.query.filter.trim()}
          </pre>
        )}
        <Button
          size="sm"
          onClick={() => connect.mutate(tab.connectionId)}
          disabled={connect.isPending}
          data-testid="reconnect-button"
        >
          {connect.isPending ? 'Connecting…' : `Connect to ${name}`}
        </Button>
        {connect.error && <ErrorBox>{connect.error.message}</ErrorBox>}
      </div>
    </div>
  )
}

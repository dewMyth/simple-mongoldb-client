import { cn } from '@renderer/lib/utils'
import { useQueryClient } from '@tanstack/react-query'
import { Columns2, Gauge, Info, KeyRound, Lock, Pin, Table2, Workflow, X } from 'lucide-react'
import { ContextMenu, type MenuItem } from '../components/Menu'
import { isReadOnly } from '@shared/permissions'
import { ipc } from '../lib/ipc'
import { keys } from '../features/connections/queries'
import { usePermissions } from '../features/permissions/queries'
import { useTabsStore } from '../stores/tabs'
import { useSavedConnections } from '../features/connections/queries'
import { colorHex } from '../features/connections/colors'

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const split = useTabsStore((s) => s.split)
  const focusedPane = useTabsStore((s) => s.focusedPane)
  const closedCount = useTabsStore((s) => s.closed.length)
  const { data: saved = [] } = useSavedConnections()
  const store = useTabsStore.getState

  return (
    <div
      className="flex h-10 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-panel px-2"
      data-testid="tab-bar"
      role="tablist"
    >
      {tabs.length === 0 && (
        <div className="flex h-8 items-center px-3 text-xs text-muted-foreground">Welcome</div>
      )}
      {tabs.map((t, i) => {
        const conn = saved.find((c) => c.id === t.connectionId)
        const color = conn ? colorHex[conn.color] : null
        const production = !!conn?.production
        const Icon =
          t.type === 'connection-info'
            ? Info
            : t.type === 'aggregation'
              ? Workflow
              : t.type === 'indexes'
                ? KeyRound
                : t.type === 'explain'
                  ? Gauge
                  : Table2
        const pane = t.id === activeId ? 'primary' : t.id === split?.tabId ? 'secondary' : null
        const focused = pane !== null && (!split || pane === focusedPane)
        const items: MenuItem[] = [
          { label: 'Duplicate', onSelect: () => store().duplicate(t.id) },
          { label: t.pinned ? 'Unpin' : 'Pin', onSelect: () => store().togglePin(t.id) },
          {
            label: 'Split right',
            onSelect: () => store().splitWith(t.id, 'horizontal'),
            separatorBefore: true
          },
          { label: 'Split down', onSelect: () => store().splitWith(t.id, 'vertical') },
          ...(split ? [{ label: 'Close split view', onSelect: () => store().closeSplit() }] : []),
          { label: 'Close', onSelect: () => store().close(t.id), separatorBefore: true },
          {
            label: 'Close others',
            onSelect: () => store().closeOthers(t.id),
            disabled: tabs.every((o) => o.id === t.id || o.pinned)
          },
          {
            label: 'Close tabs to the right',
            onSelect: () => store().closeToRight(t.id),
            disabled: !tabs.slice(i + 1).some((o) => !o.pinned)
          },
          {
            label: 'Reopen closed tab',
            onSelect: () => store().reopenClosed(),
            disabled: closedCount === 0,
            separatorBefore: true
          }
        ]
        return (
          <ContextMenu key={t.id} items={items}>
            <div
              role="tab"
              aria-selected={focused}
              data-testid={`tab-${t.ns ?? t.title}`}
              data-tab-id={t.id}
              data-pane={pane ?? undefined}
              data-pinned={t.pinned || undefined}
              data-production={production || undefined}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  if (!t.pinned) store().close(t.id)
                } else if (e.button === 0) store().activate(t.id)
              }}
              title={`${conn?.name ?? ''}${production ? ' (production)' : ''} · ${t.ns ?? t.title}`}
              className={cn(
                'group relative flex h-8 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs',
                t.pinned ? 'max-w-40 min-w-0' : 'max-w-56 min-w-28',
                pane
                  ? 'border-border bg-background text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-panel-2',
                pane && !focused && 'text-muted-foreground',
                production && 'border-destructive/70'
              )}
            >
              {color && (
                <span className="absolute inset-x-0 top-0 h-0.5 rounded-t-md" style={{ background: color }} />
              )}
              {t.pinned ? <Pin size={11} className="shrink-0" /> : <Icon size={12} className="shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {production && (
                <span className="shrink-0 rounded bg-destructive/15 px-1 text-[9px] font-semibold text-destructive">
                  PROD
                </span>
              )}
              {pane === 'secondary' && (
                <Columns2 size={11} className="shrink-0 opacity-60" aria-label="In split view" />
              )}
              <TabLock connectionId={t.connectionId} />
              {!t.pinned && (
                <button
                  type="button"
                  aria-label="Close tab"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => store().close(t.id)}
                  className={cn(
                    'rounded p-0.5 hover:bg-panel-2',
                    pane ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'
                  )}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </ContextMenu>
        )
      })}
    </div>
  )
}

/**
 * Lock shown on tabs of read-only connections. Clicking toggles the user's read-only override;
 * a secondary-only lock can't be turned off from here, so it just explains why.
 */
function TabLock({ connectionId }: { connectionId: string }) {
  const qc = useQueryClient()
  const { data: snapshot } = usePermissions(connectionId)
  if (!isReadOnly(snapshot)) return null
  const override = !!snapshot?.readOnlyOverride
  return (
    <button
      type="button"
      aria-label={override ? 'Read-only (click to allow writes)' : 'Read-only'}
      title={
        override ? 'Read-only mode is on. Click to turn it off.' : (snapshot?.secondaryReason ?? 'Read-only')
      }
      data-testid="tab-lock"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        if (!override) return
        void ipc('connections:setReadOnly', { id: connectionId, readOnly: false }).then(() =>
          qc.invalidateQueries({ queryKey: keys.saved })
        )
      }}
      className="shrink-0 rounded p-0.5 text-warn hover:bg-panel-2"
    >
      <Lock size={11} />
    </button>
  )
}

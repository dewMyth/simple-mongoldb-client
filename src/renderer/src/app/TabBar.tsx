import { cn } from '@renderer/lib/utils'
import { Info, Table2, X } from 'lucide-react'
import { useTabsStore } from '../stores/tabs'
import { useSavedConnections } from '../features/connections/queries'
import { colorHex } from '../features/connections/colors'

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const activate = useTabsStore((s) => s.activate)
  const close = useTabsStore((s) => s.close)
  const { data: saved = [] } = useSavedConnections()

  return (
    <div
      className="flex h-10 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-panel px-2"
      data-testid="tab-bar"
      role="tablist"
    >
      {tabs.length === 0 && (
        <div className="flex h-8 items-center px-3 text-xs text-muted-foreground">Welcome</div>
      )}
      {tabs.map((t) => {
        const conn = saved.find((c) => c.id === t.connectionId)
        const color = conn ? colorHex[conn.color] : null
        const Icon = t.type === 'connection-info' ? Info : Table2
        const active = t.id === activeId
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            data-testid={`tab-${t.ns ?? t.title}`}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                close(t.id)
              } else activate(t.id)
            }}
            title={`${conn?.name ?? ''} · ${t.ns ?? t.title}`}
            className={cn(
              'group relative flex h-8 max-w-56 min-w-28 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs',
              active
                ? 'border-border bg-background text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-panel-2'
            )}
          >
            {color && (
              <span className="absolute inset-x-0 top-0 h-0.5 rounded-t-md" style={{ background: color }} />
            )}
            <Icon size={12} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <button
              type="button"
              aria-label="Close tab"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => close(t.id)}
              className={cn(
                'rounded p-0.5 hover:bg-panel-2',
                active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'
              )}
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { ipc } from '../lib/ipc'
import { useTabsStore } from '../stores/tabs'
import { useActiveConnections, useSavedConnections } from '../features/connections/queries'

export function StatusBar() {
  const { data } = useQuery({ queryKey: ['app-info'], queryFn: () => ipc('app:info') })
  const { data: active = [] } = useActiveConnections()
  const { data: saved = [] } = useSavedConnections()
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId))
  const current = tab ? active.find((a) => a.id === tab.connectionId) : undefined
  const conn = tab ? saved.find((c) => c.id === tab.connectionId) : undefined

  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between gap-4 border-t border-border bg-panel px-3 text-[11px] text-muted"
      data-testid="status-bar"
    >
      <span className="truncate">
        {current && conn
          ? `${conn.name} · MongoDB ${current.server.version} · ${current.server.topology} · ${current.server.latencyMs} ms`
          : active.length
            ? `${active.length} connection${active.length > 1 ? 's' : ''} open`
            : 'Not connected'}
      </span>
      <span>{data ? `v${data.version}` : ''}</span>
    </footer>
  )
}

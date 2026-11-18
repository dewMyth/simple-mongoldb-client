import { useQuery } from '@tanstack/react-query'
import { ipc } from '../lib/ipc'

export function StatusBar() {
  const { data } = useQuery({ queryKey: ['app-info'], queryFn: () => ipc('app:info') })
  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-panel px-3 text-[11px] text-muted"
      data-testid="status-bar"
    >
      <span>Not connected</span>
      <span>{data ? `v${data.version}` : ''}</span>
    </footer>
  )
}

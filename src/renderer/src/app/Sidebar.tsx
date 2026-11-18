import { Plus } from 'lucide-react'
import { IconButton } from '../components/IconButton'
import { ThemeToggle } from './ThemeToggle'

export function Sidebar() {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-panel" data-testid="sidebar">
      <div className="flex h-10 items-center justify-between border-b border-border px-3 [-webkit-app-region:drag]">
        <span className="text-xs font-semibold tracking-wide text-muted uppercase">Connections</span>
        <div className="flex gap-1 [-webkit-app-region:no-drag]">
          <IconButton label="New connection" disabled>
            <Plus size={15} />
          </IconButton>
          <ThemeToggle />
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted">
        No connections yet.
      </div>
    </aside>
  )
}

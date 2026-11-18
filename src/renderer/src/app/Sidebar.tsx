import { useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { IconButton } from '../components/IconButton'
import { ConnectionDialog } from '../features/connections/ConnectionDialog'
import { ConnectionTree } from '../features/connections/ConnectionTree'
import { ThemeToggle } from './ThemeToggle'
import { Input } from '../components/ui/input'

export function Sidebar() {
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState('')
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-panel" data-testid="sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Connections
        </span>
        <div className="flex gap-1">
          <IconButton label="New connection" onClick={() => setCreating(true)} data-testid="new-connection">
            <Plus size={15} />
          </IconButton>
          <ThemeToggle />
        </div>
      </div>
      <div className="relative shrink-0 border-b border-border p-2">
        <Search
          size={13}
          className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter databases and collections"
          spellCheck={false}
          className="h-7 pl-7 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ConnectionTree filter={filter} />
      </div>
      {creating && <ConnectionDialog open onOpenChange={setCreating} />}
    </aside>
  )
}

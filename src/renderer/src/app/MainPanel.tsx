import { Database } from 'lucide-react'

export function MainPanel() {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center" data-testid="main-panel">
      <div className="flex flex-col items-center gap-3 text-muted">
        <Database size={40} strokeWidth={1.2} />
        <h1 className="text-lg font-medium text-fg">Mongo Studio</h1>
        <p className="text-xs">Add a connection to get started.</p>
      </div>
    </main>
  )
}

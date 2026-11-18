import { Database } from 'lucide-react'
import { useTabsStore } from '../stores/tabs'
import { ConnectionInfoPanel } from '../features/connections/ConnectionInfoPanel'
import { DocumentsTab } from '../features/documents/DocumentsTab'

export function MainPanel() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId))
  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid="main-panel">
      {!tab ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Database size={40} strokeWidth={1.2} />
            <h1 className="text-lg font-medium text-foreground">Mongo Studio</h1>
            <p className="text-xs">Connect, then pick a collection from the sidebar.</p>
          </div>
        </div>
      ) : tab.type === 'connection-info' ? (
        <ConnectionInfoPanel connectionId={tab.connectionId} />
      ) : (
        <DocumentsTab key={tab.id} tab={tab} />
      )}
    </main>
  )
}

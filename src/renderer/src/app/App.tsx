import { useEffect } from 'react'
import { useThemeStore } from '../stores/theme'
import { initWorkspace } from '../stores/workspace-persist'
import { usePermissionEvents } from '../features/permissions/queries'
import { installProductionGuard } from '../features/connections/production-guard'
import { ProductionConfirmDialog } from '../features/connections/ProductionConfirmDialog'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { MainPanel } from './MainPanel'
import { StatusBar } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import { useWorkspaceShortcuts } from './shortcuts'
import { AppDialogs } from './AppDialogs'
import { useJobEvents } from '../stores/jobs'

installProductionGuard()

export function App() {
  const init = useThemeStore((s) => s.init)
  usePermissionEvents()
  useWorkspaceShortcuts()
  useJobEvents()
  useEffect(() => {
    void init()
    void initWorkspace()
  }, [init])

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <MainPanel />
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <ProductionConfirmDialog />
      <AppDialogs />
    </div>
  )
}

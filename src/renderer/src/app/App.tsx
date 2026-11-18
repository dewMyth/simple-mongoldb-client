import { useEffect } from 'react'
import { useThemeStore } from '../stores/theme'
import { usePermissionEvents } from '../features/permissions/queries'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { MainPanel } from './MainPanel'
import { StatusBar } from './StatusBar'

export function App() {
  const init = useThemeStore((s) => s.init)
  usePermissionEvents()
  useEffect(() => {
    void init()
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
    </div>
  )
}

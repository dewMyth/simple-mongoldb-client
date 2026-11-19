import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { handle } from './router'
import { settingsStore } from '../services/settings-store'
import type { Settings } from '@shared/settings'

export function registerAppHandlers(): void {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }))

  handle('app:openExternal', async (url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be opened')
    await shell.openExternal(url)
  })

  handle('settings:get', () => settingsStore.get())
  const changed = (settings: Settings) => {
    nativeTheme.themeSource = settings.theme
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('settings:changed', settings)
    return settings
  }
  handle('settings:setTheme', (theme) => changed(settingsStore.setTheme(theme)))
  handle('settings:update', (patch) => changed(settingsStore.update(patch)))
  handle('app:openLogs', async () => {
    await shell.openPath(app.getPath('logs'))
  })
}

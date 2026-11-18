import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { handle } from './router'
import { settingsStore } from '../services/settings-store'

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
  handle('settings:setTheme', (theme) => {
    const settings = settingsStore.setTheme(theme)
    nativeTheme.themeSource = theme
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('settings:changed', settings)
    return settings
  })
}

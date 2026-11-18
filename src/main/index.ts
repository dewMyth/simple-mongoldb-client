import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { applyGlobalSecurity, hardenWebContents } from './security'
import { settingsStore } from './services/settings-store'

const here = import.meta.dirname
const devServerUrl = process.env['ELECTRON_RENDERER_URL']

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Mongo Studio',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0f14' : '#ffffff',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  hardenWebContents(win.webContents, () => (devServerUrl ? new URL(devServerUrl).origin : 'file://'))
  win.once('ready-to-show', () => win.show())

  if (devServerUrl) void win.loadURL(devServerUrl)
  else void win.loadFile(join(here, '../renderer/index.html'))

  return win
}

app.setName('Mongo Studio')

void app.whenReady().then(() => {
  nativeTheme.themeSource = settingsStore.get().theme
  applyGlobalSecurity()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { applyGlobalSecurity, hardenWebContents } from './security'
import { settingsStore } from './services/settings-store'
import { connections, cursors, importExport, shells } from './services'
import { initLog, log } from './services/log'

const here = import.meta.dirname
const devServerUrl = process.env['ELECTRON_RENDERER_URL']

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // E2E fixes the window size; on macOS that needs to exceed small CI screens.
    enableLargerThanScreen: process.env['MONGO_STUDIO_E2E'] === '1',
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

// An explicit --password-store on our command line wins over one appended at startup: Playwright's
// Electron loader appends --password-store=basic (no encryption on Linux), and E2E needs a real keyring.
const passwordStore = process.argv.find((a) => a.startsWith('--password-store='))
if (passwordStore)
  app.commandLine.appendSwitch('password-store', passwordStore.slice('--password-store='.length))

process.on('uncaughtException', (err) => log.error('uncaught exception', {}, err))
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', {}, reason))
app.on('render-process-gone', (_e, _wc, details) =>
  log.error('renderer gone', { reason: details.reason, exitCode: details.exitCode })
)
app.on('child-process-gone', (_e, details) =>
  log.warn('child process gone', { type: details.type, reason: details.reason })
)

void app.whenReady().then(() => {
  initLog(app.getPath('logs'))
  log.info('startup', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform} ${process.arch}`,
    packaged: app.isPackaged
  })
  nativeTheme.themeSource = settingsStore.get().theme
  applyGlobalSecurity()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  // Close MongoClients and SSH tunnels cleanly so server-side cursors and sessions are released.
  event.preventDefault()
  quitting = true
  log.info('quit')
  void Promise.all([cursors.cancelAll(), shells.closeAll(), importExport.cancelAll()])
    .then(() => connections.disconnectAll())
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

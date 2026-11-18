import { BrowserWindow, dialog } from 'electron'
import { handle } from './router'
import { connections, cursors, databases, storage } from '../services'

export function registerConnectionHandlers(): void {
  connections.onChange(() => {
    const active = connections.active()
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('connections:activeChanged', active)
  })

  handle('dialog:openFile', async ({ title, filters }, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = { title, filters, properties: ['openFile' as const, 'showHiddenFiles' as const] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  handle('connections:list', () => storage.list())
  handle('connections:save', (draft) => storage.save(draft))
  handle('connections:delete', async (id) => {
    await cursors.cancelForConnection(id)
    await connections.disconnect(id)
    storage.delete(id)
  })
  handle('connections:test', (draft) => connections.test(storage.resolveDraft(draft)))
  handle('connections:connect', async (id) => {
    const info = await connections.connect(storage.resolve(id))
    storage.touch(id)
    return info
  })
  handle('connections:disconnect', async (id) => {
    await cursors.cancelForConnection(id)
    await connections.disconnect(id)
  })
  handle('connections:active', () => connections.active())

  handle('db:listDatabases', (id) => databases.listDatabases(id))
  handle('db:listCollections', ({ connectionId, db }) => databases.listCollections(connectionId, db))
  handle('db:createCollection', ({ connectionId, db, name, ...opts }) =>
    databases.createCollection(connectionId, db, name, opts)
  )
  handle('db:dropCollection', ({ connectionId, db, name }) =>
    databases.dropCollection(connectionId, db, name)
  )
  handle('db:dropDatabase', ({ connectionId, db }) => databases.dropDatabase(connectionId, db))
}

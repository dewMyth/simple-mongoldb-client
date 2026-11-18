import { BrowserWindow, dialog } from 'electron'
import { handle } from './router'
import { connections, cursors, databases, permissions, storage } from '../services'

function broadcast(channel: 'connections:activeChanged' | 'permissions:changed', payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

async function closeConnection(id: string) {
  await cursors.cancelForConnection(id)
  await connections.disconnect(id)
  permissions.clear(id)
}

export function registerConnectionHandlers(): void {
  connections.onChange(() => broadcast('connections:activeChanged', connections.active()))
  permissions.onChange((snapshot) => broadcast('permissions:changed', snapshot))

  handle('dialog:openFile', async ({ title, filters }, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = { title, filters, properties: ['openFile' as const, 'showHiddenFiles' as const] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  handle('connections:list', () => storage.list())
  handle('connections:save', (draft) => {
    const saved = storage.save(draft)
    permissions.setReadOnly(saved.id, saved.readOnly)
    return saved
  })
  handle('connections:setReadOnly', ({ id, readOnly }) => {
    const saved = storage.setReadOnly(id, readOnly)
    permissions.setReadOnly(id, readOnly)
    return saved
  })
  handle('connections:delete', async (id) => {
    await closeConnection(id)
    storage.delete(id)
  })
  handle('connections:test', (draft) => connections.test(storage.resolveDraft(draft)))
  handle('connections:connect', async (id) => {
    const resolved = storage.resolve(id)
    const info = await connections.connect(resolved)
    // Keep an existing snapshot (and what it has learned) if this connection was already open.
    if (!permissions.get(id))
      await permissions.load(id, connections.client(id), info.server, resolved.readOnly)
    storage.touch(id)
    return info
  })
  handle('connections:disconnect', (id) => closeConnection(id))
  handle('connections:active', () => connections.active())
  handle('permissions:get', (id) => permissions.get(id))

  handle('db:listDatabases', (id) => databases.listDatabases(id))
  handle('db:listCollections', ({ connectionId, db }) => databases.listCollections(connectionId, db))
  // Every write goes through permissions.guard(): checked in main, and Unauthorized errors are learned.
  handle('db:createCollection', ({ connectionId, db, name, ...opts }) =>
    permissions.guard(connectionId, `${db}.${name}`, 'createCollection', () =>
      databases.createCollection(connectionId, db, name, opts)
    )
  )
  handle('db:dropCollection', ({ connectionId, db, name }) =>
    permissions.guard(connectionId, `${db}.${name}`, 'dropCollection', () =>
      databases.dropCollection(connectionId, db, name)
    )
  )
  handle('db:dropDatabase', ({ connectionId, db }) =>
    permissions.guard(connectionId, db, 'dropDatabase', () => databases.dropDatabase(connectionId, db))
  )
}

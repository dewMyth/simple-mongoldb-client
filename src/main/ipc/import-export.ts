import { BrowserWindow, dialog, shell } from 'electron'
import { handle } from './router'
import { importExport, permissions, schemas } from '../services'
import { isUnauthorized } from '../services/permission-service'
import { setFilterField } from '../services/query-parser'

async function learnRead<T>(connectionId: string, ns: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isUnauthorized(err)) permissions.recordDenied(connectionId, ns, 'find', err)
    throw err
  }
}

export function registerImportExportHandlers(): void {
  handle('schema:analyze', (input) => learnRead(input.connectionId, input.ns, () => schemas.analyze(input)))
  handle('query:setFilterField', ({ filter, path, valueText }) => setFilterField(filter, path, valueText))

  // Files are chosen in main's own dialogs; the renderer only ever gets a token.
  handle('files:chooseExport', async ({ defaultName }, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const ext = defaultName.split('.').pop() ?? 'json'
    const opts = { defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    return res.canceled || !res.filePath ? null : importExport.registerFile(res.filePath, 'write')
  })
  handle('files:chooseImport', async (_input, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = {
      properties: ['openFile' as const],
      filters: [
        { name: 'JSON, JSON lines or CSV', extensions: ['json', 'jsonl', 'ndjson', 'ejson', 'csv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const path = res.canceled ? undefined : res.filePaths[0]
    return path ? importExport.registerFile(path, 'read') : null
  })

  handle('export:start', (input) => importExport.startExport(input).progress)
  handle('import:preview', ({ token, format }) => importExport.preview(token, format))
  handle('import:start', (input) => {
    // Checked up front (read-only, privileges), and the run learns from Unauthorized.
    permissions.assert(input.connectionId, input.ns, 'insert')
    return importExport.startImport(input, (fn) =>
      permissions.guard(input.connectionId, input.ns, 'insert', fn)
    ).progress
  })
  handle('jobs:cancel', (jobId) => importExport.cancel(jobId))
  handle('jobs:reveal', (jobId) => {
    const path = importExport.pathOf(jobId)
    if (path) shell.showItemInFolder(path)
  })
}

import { handle } from './router'
import { documents, permissions } from '../services'

export function registerDocumentHandlers(): void {
  handle('docs:parse', (text) => documents.parseDocuments(text))

  // Every write is checked (and learns from Unauthorized) via permissions.guard.
  handle('docs:update', async (input) => {
    // Overwrite can re-create a document someone deleted, so it also needs insert.
    if (input.force) permissions.assert(input.connectionId, input.ns, 'insert')
    return permissions.guard(input.connectionId, input.ns, 'update', () => documents.update(input))
  })
  handle('docs:insert', (input) =>
    permissions.guard(input.connectionId, input.ns, 'insert', () => documents.insert(input))
  )
  handle('docs:deleteOne', (input) =>
    permissions.guard(input.connectionId, input.ns, 'remove', () => documents.deleteOne(input))
  )
  handle('docs:deleteMany', (input) =>
    permissions.guard(input.connectionId, input.ns, 'remove', () => documents.deleteMany(input))
  )
  handle('docs:updateMany', (input) =>
    permissions.guard(input.connectionId, input.ns, 'update', () => documents.updateMany(input))
  )
  handle('docs:previewUpdate', (input) => documents.previewUpdate(input))
}

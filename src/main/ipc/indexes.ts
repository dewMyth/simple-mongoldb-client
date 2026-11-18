import { handle } from './router'
import { explains, indexes, permissions } from '../services'
import { isUnauthorized } from '../services/permission-service'

async function learnRead<T>(connectionId: string, ns: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isUnauthorized(err)) permissions.recordDenied(connectionId, ns, 'find', err)
    throw err
  }
}

export function registerIndexHandlers(): void {
  handle('indexes:list', ({ connectionId, ns }) => indexes.list(connectionId, ns))
  handle('indexes:builds', ({ connectionId, ns }) => indexes.builds(connectionId, ns))
  // Writes are checked (and learn from Unauthorized) via permissions.guard.
  handle('indexes:create', ({ connectionId, ns, form }) =>
    permissions.guard(connectionId, ns, 'createIndex', () => indexes.create(connectionId, ns, form))
  )
  handle('indexes:drop', ({ connectionId, ns, name }) =>
    permissions.guard(connectionId, ns, 'dropIndex', () => indexes.drop(connectionId, ns, name))
  )
  handle('indexes:setHidden', ({ connectionId, ns, name, hidden }) =>
    permissions.guard(connectionId, ns, 'collMod', () => indexes.setHidden(connectionId, ns, name, hidden))
  )
  handle('explain:run', (input) => learnRead(input.connectionId, input.ns, () => explains.explain(input)))
}

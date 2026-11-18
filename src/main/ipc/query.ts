import { handle } from './router'
import { cursors, history, permissions, queries, schemas } from '../services'
import { isUnauthorized } from '../services/permission-service'

/**
 * Reads are never blocked up front (the server is the authority), but an Unauthorized result
 * is remembered so the UI can explain it and stop offering the action.
 */
async function learnFind<T>(connectionId: string, ns: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isUnauthorized(err)) permissions.recordDenied(connectionId, ns, 'find', err)
    throw err
  }
}
import { convertQueryText, formatQueryText, parseQuery, validateQueryField } from '../services/query-parser'
import { splitNamespace } from '../services/query-service'
import { exportQuery } from '@shared/code-export'

export function registerQueryHandlers(): void {
  cursors.start()

  handle('query:validate', ({ field, text }) => validateQueryField(field, text))
  handle('query:format', ({ field, text }) => formatQueryText(text, field))
  handle('query:convert', ({ field, text, to }) => convertQueryText(text, field, to))
  handle('query:exportCode', ({ ns, query, language, mode }) => {
    const parsed = parseQuery(query)
    if (!parsed.ok) return { ok: false, errors: parsed.errors }
    const { db, coll } = splitNamespace(ns)
    return { ok: true, code: exportQuery(language, { db, collection: coll }, parsed.query, mode) }
  })
  handle('query:find', (input) => learnFind(input.connectionId, input.ns, () => queries.find(input)))
  handle('query:getMore', ({ cursorId, count }) => queries.getMore(cursorId, count))
  handle('query:count', (input) => learnFind(input.connectionId, input.ns, () => queries.count(input)))
  handle('schema:sampleFields', (input) =>
    learnFind(input.connectionId, input.ns, () => schemas.sampleFields(input))
  )
  handle('ops:cancel', (id) => cursors.cancel(id))
  handle('ops:cancelForTab', (tabId) => cursors.cancelForTab(tabId))

  handle('history:list', ({ connectionId, ns }) => history.list(connectionId, ns))
  handle('history:add', ({ connectionId, ns, query }) => history.add(connectionId, ns, query))
  handle('history:clear', ({ connectionId, ns }) => history.clear(connectionId, ns))
  handle('favorites:list', (ns) => history.listFavorites(ns))
  handle('favorites:save', (input) => history.saveFavorite(input))
  handle('favorites:delete', (id) => history.deleteFavorite(id))
}

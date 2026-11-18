import { handle } from './router'
import { cursors, history, queries } from '../services'
import { formatQueryText, validateQueryField } from '../services/query-parser'

export function registerQueryHandlers(): void {
  cursors.start()

  handle('query:validate', ({ field, text }) => validateQueryField(field, text))
  handle('query:format', ({ field, text }) => formatQueryText(text, field))
  handle('query:find', (input) => queries.find(input))
  handle('query:getMore', ({ cursorId, count }) => queries.getMore(cursorId, count))
  handle('query:count', (input) => queries.count(input))
  handle('ops:cancel', (id) => cursors.cancel(id))
  handle('ops:cancelForTab', (tabId) => cursors.cancelForTab(tabId))

  handle('history:list', ({ connectionId, ns }) => history.list(connectionId, ns))
  handle('history:add', ({ connectionId, ns, query }) => history.add(connectionId, ns, query))
  handle('history:clear', ({ connectionId, ns }) => history.clear(connectionId, ns))
  handle('favorites:list', (ns) => history.listFavorites(ns))
  handle('favorites:save', (input) => history.saveFavorite(input))
  handle('favorites:delete', (id) => history.deleteFavorite(id))
}

import { emptyQueryText } from '@shared/query'
import { useTabsStore } from '../../stores/tabs'

/** Opens (or switches to) the Schema tab of a collection, starting from a filter. */
export function openSchema(connectionId: string, ns: string, filter = ''): string {
  return useTabsStore.getState().open({
    type: 'schema',
    connectionId,
    ns,
    title: `${ns.slice(ns.indexOf('.') + 1)} · schema`,
    query: { ...emptyQueryText, filter }
  })
}

import { registerAppHandlers } from './app'
import { registerConnectionHandlers } from './connections'
import { registerQueryHandlers } from './query'
import { registerDocumentHandlers } from './documents'
import { registerAggregationHandlers } from './aggregation'
import { registerIndexHandlers } from './indexes'

export function registerIpcHandlers(): void {
  registerAppHandlers()
  registerConnectionHandlers()
  registerQueryHandlers()
  registerDocumentHandlers()
  registerAggregationHandlers()
  registerIndexHandlers()
}

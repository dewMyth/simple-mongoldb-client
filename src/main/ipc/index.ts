import { registerAppHandlers } from './app'
import { registerConnectionHandlers } from './connections'
import { registerQueryHandlers } from './query'
import { registerDocumentHandlers } from './documents'

export function registerIpcHandlers(): void {
  registerAppHandlers()
  registerConnectionHandlers()
  registerQueryHandlers()
  registerDocumentHandlers()
}

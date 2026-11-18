import { registerAppHandlers } from './app'
import { registerConnectionHandlers } from './connections'
import { registerQueryHandlers } from './query'

export function registerIpcHandlers(): void {
  registerAppHandlers()
  registerConnectionHandlers()
  registerQueryHandlers()
}

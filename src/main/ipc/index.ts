import { registerAppHandlers } from './app'
import { registerConnectionHandlers } from './connections'

export function registerIpcHandlers(): void {
  registerAppHandlers()
  registerConnectionHandlers()
}

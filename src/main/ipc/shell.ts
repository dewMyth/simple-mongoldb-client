import { handle } from './router'
import { shells } from '../services'

export function registerShellHandlers(): void {
  handle('shell:start', (input) => shells.start(input))
  handle('shell:evaluate', ({ sessionId, code }) => shells.evaluate(sessionId, code))
  handle('shell:interrupt', (sessionId) => shells.interrupt(sessionId))
  handle('shell:complete', ({ sessionId, code }) => shells.complete(sessionId, code))
  handle('shell:close', (sessionId) => shells.close(sessionId))
}

/** App/runtime versions from main, fetched once (for error details and Settings). */
import type { AppInfo } from '@shared/ipc-contract'
import { ipc } from './ipc'

let cached: Promise<AppInfo | null> | null = null

export function appInfo(): Promise<AppInfo | null> {
  cached ??= ipc('app:info').catch(() => {
    cached = null
    return null
  })
  return cached
}

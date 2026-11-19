/**
 * Text for "Copy details" on errors: message, error name/code, app version and platform, for bug
 * reports. Never includes documents, queries or connection strings (only what the error says).
 */
import type { AppInfo } from './ipc-contract'

export interface ErrorLike {
  name?: string
  message?: string
  code?: number | string
  codeName?: string
  stack?: string
}

export function errorDetails(message: string, error?: unknown, info?: AppInfo | null): string {
  const e = (error && typeof error === 'object' ? error : {}) as ErrorLike
  const lines = [message.trim() || e.message || 'Unknown error']
  if (e.message && e.message !== message) lines.push(`Message: ${e.message}`)
  if (e.name && e.name !== 'Error') lines.push(`Error: ${e.name}`)
  if (e.code !== undefined) lines.push(`Code: ${e.code}${e.codeName ? ` (${e.codeName})` : ''}`)
  else if (e.codeName) lines.push(`Code: ${e.codeName}`)
  if (info) {
    lines.push(`App: ${info.name} ${info.version}`)
    lines.push(`Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node} · ${info.platform}`)
  }
  if (e.stack) lines.push('', e.stack)
  return lines.join('\n')
}

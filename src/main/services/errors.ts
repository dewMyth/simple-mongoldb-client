/**
 * Turns driver/network errors into messages a person can act on. The original message is kept
 * after the readable one so "copy details" still has it.
 */
interface ErrLike {
  name?: string
  message?: string
  code?: number | string
  codeName?: string
  cause?: unknown
  reason?: { servers?: Map<string, { error?: unknown }> }
}

const serverCodes: Record<number, string> = {
  13: 'Not authorized: your user lacks the privilege for this action.',
  18: 'Authentication failed: check the username, password and authSource.',
  50: 'The operation exceeded its time limit (maxTimeMS).',
  11000: 'Duplicate key: a document with this unique key already exists.',
  26: 'Namespace not found.',
  48: 'A collection or view with this name already exists.',
  59: 'Command not found: the server does not support this operation.',
  211: 'Key not found: possibly a TLS/KMS configuration problem.'
}

function rootCause(err: ErrLike): ErrLike {
  // Server selection errors hide the real cause (ECONNREFUSED, ENOTFOUND, TLS) in reason.servers.
  const servers = err.reason?.servers
  if (servers) {
    for (const s of servers.values()) if (s.error) return rootCause(s.error as ErrLike)
  }
  if (err.cause && typeof err.cause === 'object') return rootCause(err.cause as ErrLike)
  return err
}

export function readableMessage(error: unknown): string {
  const err = (error ?? {}) as ErrLike
  const msg = err.message ?? String(error)
  const root = rootCause(err)
  const rootMsg = root.message ?? ''
  const all = `${msg} ${rootMsg}`

  if (typeof err.code === 'number' && serverCodes[err.code]) return `${serverCodes[err.code]} (${msg})`
  if (/ECONNREFUSED/.test(all) || root.code === 'ECONNREFUSED')
    return `Connection refused. Is MongoDB running and reachable at that host and port? (${rootMsg || msg})`
  if (/ENOTFOUND|EAI_AGAIN/.test(all))
    return `Host not found. Check the host name and your DNS/network. (${rootMsg || msg})`
  if (/querySrv|_mongodb\._tcp/.test(all))
    return `SRV lookup failed. Check the cluster host name. (${rootMsg || msg})`
  if (/ETIMEDOUT|timed out/i.test(all) && !/Server selection/.test(rootMsg))
    return `Connection timed out. A firewall or IP access list may be blocking you. (${rootMsg || msg})`
  if (/certificate|self[- ]signed|SSL|TLS|tlsv1/i.test(all)) return `TLS error: ${rootMsg || msg}`
  if (/Authentication failed|auth failed/i.test(all)) return `${serverCodes[18]} (${msg})`
  if (err.name === 'MongoServerSelectionError')
    return `Could not reach any server before the timeout. ${rootMsg && rootMsg !== msg ? rootMsg : msg}`
  return msg
}

export class ReadableError extends Error {
  readonly code?: number
  readonly codeName?: string
  constructor(error: unknown) {
    super(readableMessage(error))
    const e = error as ErrLike
    this.name = e?.name ?? 'Error'
    if (typeof e?.code === 'number') this.code = e.code
    if (typeof e?.codeName === 'string') this.codeName = e.codeName
  }
}

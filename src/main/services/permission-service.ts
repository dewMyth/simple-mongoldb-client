/**
 * Builds and enforces the per-connection permission snapshot (see src/shared/permissions.ts).
 *
 * Enforcement lives here, in main: every write path calls guard(), so a renderer bug (or a
 * crafted IPC call) still can't bypass the read-only override or a missing privilege.
 */
import type { MongoClient } from 'mongodb'
import type { ServerInfo } from '@shared/connection'
import {
  can,
  type PermissionAction,
  type PermissionCheck,
  type PermissionSnapshot,
  type Privilege
} from '@shared/permissions'
import { readableMessage } from './errors'

interface AuthInfo {
  authenticatedUsers?: { user: string; db: string }[]
  authenticatedUserRoles?: { role: string; db: string }[]
  authenticatedUserPrivileges?: Privilege[]
}

export type StatusLoader = (client: MongoClient) => Promise<AuthInfo>

const defaultLoader: StatusLoader = async (client) => {
  const res = await client.db('admin').command({ connectionStatus: 1, showPrivileges: true })
  return (res['authInfo'] ?? {}) as AuthInfo
}

export class PermissionDeniedError extends Error {
  override name = 'PermissionDeniedError'
  readonly code = 13
  readonly codeName = 'Unauthorized'
}

export const isUnauthorized = (err: unknown) => (err as { code?: unknown })?.code === 13

export class PermissionService {
  private readonly snapshots = new Map<string, PermissionSnapshot>()
  private readonly listeners = new Set<(s: PermissionSnapshot) => void>()

  constructor(private readonly loader: StatusLoader = defaultLoader) {}

  onChange(listener: (s: PermissionSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(s: PermissionSnapshot) {
    this.snapshots.set(s.connectionId, s)
    for (const l of this.listeners) l(s)
  }

  async load(
    connectionId: string,
    client: MongoClient,
    server: ServerInfo,
    readOnlyOverride: boolean
  ): Promise<PermissionSnapshot> {
    const base: PermissionSnapshot = {
      connectionId,
      mode: 'optimistic',
      users: [],
      roles: [],
      privileges: [],
      readOnlyOverride,
      secondaryReason: server.isSecondaryRead
        ? 'This connection reads from a secondary (direct connection or a non-primary readPreference), so writes are disabled.'
        : null,
      denied: [],
      statusError: null
    }
    try {
      const info = await this.loader(client)
      const users = info.authenticatedUsers ?? []
      const privileges = info.authenticatedUserPrivileges ?? []
      base.users = users
      base.roles = info.authenticatedUserRoles ?? []
      base.privileges = privileges
      // No user at all: auth is off (typical local dev). Users but no privileges: a proxy or
      // service that doesn't report them, so learn from errors instead.
      base.mode = users.length === 0 ? 'noAuth' : privileges.length === 0 ? 'optimistic' : 'privileges'
    } catch (err) {
      base.mode = 'optimistic'
      base.statusError = readableMessage(err)
    }
    this.set(base)
    return base
  }

  get(connectionId: string): PermissionSnapshot | null {
    return this.snapshots.get(connectionId) ?? null
  }

  clear(connectionId: string): void {
    this.snapshots.delete(connectionId)
  }

  setReadOnly(connectionId: string, readOnly: boolean): void {
    const s = this.snapshots.get(connectionId)
    if (s && s.readOnlyOverride !== readOnly) this.set({ ...s, readOnlyOverride: readOnly })
  }

  check(connectionId: string, ns: string, action: PermissionAction): PermissionCheck {
    return can(this.snapshots.get(connectionId), ns, action)
  }

  assert(connectionId: string, ns: string, action: PermissionAction): void {
    const res = this.check(connectionId, ns, action)
    if (!res.allowed) throw new PermissionDeniedError(res.reason ?? `Not allowed: ${action} on ${ns}`)
  }

  /** Remembers a server-side Unauthorized so the UI disables that action for the session. */
  recordDenied(connectionId: string, ns: string, action: PermissionAction, err: unknown): void {
    const s = this.snapshots.get(connectionId)
    if (!s || s.denied.some((d) => d.ns === ns && d.action === action)) return
    const detail = (err as Error)?.message?.replace(/^Not authorized: [^(]*\(|\)$/g, '') ?? ''
    this.set({
      ...s,
      denied: [
        ...s.denied,
        {
          ns,
          action,
          message: `The server rejected \`${action}\` on \`${ns}\` (Unauthorized). ${detail}`.trim()
        }
      ]
    })
  }

  /** Checks first, runs, and learns from Unauthorized errors. */
  async guard<T>(
    connectionId: string,
    ns: string,
    action: PermissionAction,
    fn: () => Promise<T>
  ): Promise<T> {
    this.assert(connectionId, ns, action)
    try {
      return await fn()
    } catch (err) {
      if (isUnauthorized(err)) this.recordDenied(connectionId, ns, action, err)
      throw err
    }
  }
}

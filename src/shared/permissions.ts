/**
 * Permission model: a snapshot of what the connected user may do, and a pure `can()` used by both
 * main (to enforce) and the renderer (to disable buttons with a reason).
 *
 * Sources, applied in this order (any "deny" wins; nothing here can grant beyond the server):
 *  1. The per-connection read-only override.
 *  2. Reading from a secondary (directConnection to a secondary, or readPreference ≠ primary).
 *  3. Actions the server has already rejected this session with Unauthorized (code 13).
 *  4. The privilege matrix from connectionStatus (mode "privileges" only).
 */

export const writeActions = [
  'insert',
  'update',
  'remove',
  'createIndex',
  'dropIndex',
  'createCollection',
  'dropCollection',
  'dropDatabase',
  'collMod'
] as const
export const permissionActions = ['find', ...writeActions] as const
export type PermissionAction = (typeof permissionActions)[number]

/** Actions checked against a collection namespace ("db.coll"). */
export const collectionActions: PermissionAction[] = permissionActions.filter((a) => a !== 'dropDatabase')
/** Actions checked against a database namespace ("db"). */
export const databaseActions: PermissionAction[] = ['createCollection', 'dropDatabase']

export const isWriteAction = (a: PermissionAction) => a !== 'find'

export interface PrivilegeResource {
  db?: string
  collection?: string
  cluster?: boolean
  anyResource?: boolean
}

export interface Privilege {
  resource: PrivilegeResource
  actions: string[]
}

/**
 * - privileges: the server reported the user's privileges; enforce them.
 * - noAuth: no authenticated user (auth disabled, typical local dev); allow everything.
 * - optimistic: privileges unavailable (proxies, Atlas Data Federation, command failed); allow
 *   in the UI and learn from Unauthorized errors.
 */
export type PermissionMode = 'privileges' | 'noAuth' | 'optimistic'

export interface DeniedAction {
  ns: string
  action: PermissionAction
  message: string
}

export interface PermissionSnapshot {
  connectionId: string
  mode: PermissionMode
  users: { user: string; db: string }[]
  roles: { role: string; db: string }[]
  privileges: Privilege[]
  /** Per-connection read-only override. */
  readOnlyOverride: boolean
  /** Why reads come from a secondary (writes disabled), or null. */
  secondaryReason: string | null
  /** Actions the server rejected this session (optimistic learning). */
  denied: DeniedAction[]
  /** Set when connectionStatus failed, to explain optimistic mode. */
  statusError: string | null
}

export interface PermissionCheck {
  allowed: boolean
  reason?: string
}

/** Splits "db" or "db.collection" (collection names may contain dots). */
export function splitNs(ns: string): { db: string; collection: string } {
  const dot = ns.indexOf('.')
  return dot < 0 ? { db: ns, collection: '' } : { db: ns.slice(0, dot), collection: ns.slice(dot + 1) }
}

/**
 * MongoDB resource matching rules:
 *  - { anyResource: true } matches everything, including system collections.
 *  - { cluster: true } never matches a namespace.
 *  - { db: "a", collection: "b" } matches exactly a.b.
 *  - "" is a wildcard for db and/or collection, but a wildcard collection does not cover
 *    system.* collections. A db-level check (no collection) only matches collection "".
 */
export function resourceMatches(resource: PrivilegeResource, ns: string): boolean {
  if (resource.anyResource) return true
  if (resource.cluster) return false
  if (resource.db === undefined || resource.collection === undefined) return false
  const { db, collection } = splitNs(ns)
  const dbOk = resource.db === '' || resource.db === db
  if (!dbOk) return false
  if (collection === '') return resource.collection === ''
  if (resource.collection === '') return !collection.startsWith('system.')
  return resource.collection === collection
}

function hasPrivilege(privileges: Privilege[], ns: string, action: PermissionAction): boolean {
  return privileges.some((p) => p.actions.includes(action) && resourceMatches(p.resource, ns))
}

/** Whether the user may perform `action` on `ns` ("db" for database-level actions, else "db.coll"). */
export function can(
  snapshot: PermissionSnapshot | null | undefined,
  ns: string,
  action: PermissionAction
): PermissionCheck {
  if (!snapshot) return { allowed: false, reason: 'Not connected' }
  const write = isWriteAction(action)
  if (write && snapshot.readOnlyOverride) {
    return { allowed: false, reason: 'Read-only mode is on for this connection.' }
  }
  if (write && snapshot.secondaryReason) {
    return { allowed: false, reason: snapshot.secondaryReason }
  }
  const denied = snapshot.denied.find((d) => d.action === action && (d.ns === ns || d.ns === splitNs(ns).db))
  if (denied) return { allowed: false, reason: denied.message }
  if (snapshot.mode !== 'privileges') return { allowed: true }
  if (hasPrivilege(snapshot.privileges, ns, action)) return { allowed: true }
  const who = snapshot.users.map((u) => u.user).join(', ') || 'Your user'
  return { allowed: false, reason: `${who} lacks \`${action}\` on \`${ns}\`.` }
}

export function isReadOnly(snapshot: PermissionSnapshot | null | undefined): boolean {
  return !!snapshot && (snapshot.readOnlyOverride || !!snapshot.secondaryReason)
}

/**
 * Creating a brand-new database needs createCollection on a database the user has no specific
 * grant for, i.e. a wildcard ({ db: "" }) or anyResource privilege.
 */
export function canCreateDatabase(snapshot: PermissionSnapshot | null | undefined): PermissionCheck {
  const res = can(snapshot, '', 'createCollection')
  if (
    res.allowed ||
    !snapshot ||
    snapshot.mode !== 'privileges' ||
    res.reason?.includes('Read-only') ||
    snapshot.secondaryReason
  )
    return res
  const who = snapshot.users.map((u) => u.user).join(', ') || 'Your user'
  return {
    allowed: false,
    reason: `${who} can't create new databases (needs \`createCollection\` on any database).`
  }
}

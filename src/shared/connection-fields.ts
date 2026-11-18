/**
 * Two-way mapping between a connection string and the "fields" form.
 * Pure functions (no driver), used by the renderer form and unit-tested in node.
 */
import { ConnectionString } from 'mongodb-connection-string-url'

export type AuthMechanism = 'none' | 'DEFAULT' | 'SCRAM-SHA-256' | 'SCRAM-SHA-1' | 'MONGODB-X509'
export type TlsMode = 'default' | 'on' | 'off'
export type ReadPreference =
  '' | 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest'

export interface ConnectionFields {
  scheme: 'mongodb' | 'mongodb+srv'
  /** host:port entries (one for SRV, no port). */
  hosts: string[]
  directConnection: boolean
  authMechanism: AuthMechanism
  username: string
  password: string
  authSource: string
  defaultDatabase: string
  tls: TlsMode
  tlsCAFile: string
  tlsCertificateKeyFile: string
  tlsAllowInvalidCertificates: boolean
  tlsAllowInvalidHostnames: boolean
  replicaSet: string
  readPreference: ReadPreference
  appName: string
}

export const DEFAULT_URI = 'mongodb://localhost:27017'

function bool(v: string | null): boolean {
  return v === 'true'
}

export function parseConnectionString(uri: string): ConnectionString {
  return new ConnectionString(uri, { looseValidation: true })
}

export function uriToFields(uri: string): ConnectionFields {
  const cs = parseConnectionString(uri)
  const p = cs.searchParams
  const mech = p.get('authMechanism')
  const hasUser = cs.username !== ''
  const tlsParam = p.get('tls') ?? p.get('ssl')
  return {
    scheme: cs.isSRV ? 'mongodb+srv' : 'mongodb',
    hosts: [...cs.hosts],
    directConnection: bool(p.get('directConnection')),
    authMechanism:
      mech === 'SCRAM-SHA-256' || mech === 'SCRAM-SHA-1' || mech === 'MONGODB-X509'
        ? mech
        : hasUser
          ? 'DEFAULT'
          : 'none',
    username: decodeURIComponent(cs.username),
    password: decodeURIComponent(cs.password),
    authSource: p.get('authSource') ?? '',
    defaultDatabase: decodeURIComponent(cs.pathname.replace(/^\//, '')),
    tls: tlsParam === 'true' ? 'on' : tlsParam === 'false' ? 'off' : 'default',
    tlsCAFile: p.get('tlsCAFile') ?? '',
    tlsCertificateKeyFile: p.get('tlsCertificateKeyFile') ?? '',
    tlsAllowInvalidCertificates: bool(p.get('tlsAllowInvalidCertificates')) || bool(p.get('tlsInsecure')),
    tlsAllowInvalidHostnames: bool(p.get('tlsAllowInvalidHostnames')),
    replicaSet: p.get('replicaSet') ?? '',
    readPreference: (p.get('readPreference') as ReadPreference | null) ?? '',
    appName: p.get('appName') ?? ''
  }
}

function setParam(cs: ConnectionString, key: string, value: string | boolean | null | undefined) {
  if (value === '' || value === false || value === null || value === undefined) cs.searchParams.delete(key)
  else cs.searchParams.set(key, value === true ? 'true' : value)
}

/** Applies form fields onto an existing URI, preserving any parameters the form doesn't know. */
export function fieldsToUri(fields: ConnectionFields, baseUri: string = DEFAULT_URI): string {
  let cs: ConnectionString
  try {
    cs = parseConnectionString(baseUri)
  } catch {
    cs = parseConnectionString(DEFAULT_URI)
  }
  const isSrv = fields.scheme === 'mongodb+srv'
  const hosts = fields.hosts.map((h) => h.trim()).filter(Boolean)
  const safeHosts = hosts.length ? (isSrv ? [hosts[0]!.replace(/:\d+$/, '')] : hosts) : ['localhost:27017']

  // Changing scheme can't be done in place; rebuild and copy params across.
  if (cs.isSRV !== isSrv) {
    const params = cs.searchParams.toString()
    cs = parseConnectionString(`${fields.scheme}://${safeHosts.join(',')}/${params ? `?${params}` : ''}`)
  }
  cs.hosts = safeHosts

  const usesCredentials = fields.authMechanism !== 'none'
  const isX509 = fields.authMechanism === 'MONGODB-X509'
  cs.username = usesCredentials && fields.username ? encodeURIComponent(fields.username) : ''
  cs.password = usesCredentials && !isX509 && fields.password ? encodeURIComponent(fields.password) : ''
  cs.pathname = fields.defaultDatabase ? `/${encodeURIComponent(fields.defaultDatabase)}` : '/'

  setParam(
    cs,
    'authMechanism',
    fields.authMechanism === 'none' || fields.authMechanism === 'DEFAULT' ? '' : fields.authMechanism
  )
  setParam(cs, 'authSource', usesCredentials ? fields.authSource : '')
  setParam(cs, 'directConnection', !isSrv && fields.directConnection)
  cs.searchParams.delete('ssl')
  setParam(cs, 'tls', fields.tls === 'on' ? 'true' : fields.tls === 'off' ? 'false' : '')
  const tlsActive = fields.tls !== 'off'
  setParam(cs, 'tlsCAFile', tlsActive ? fields.tlsCAFile : '')
  setParam(cs, 'tlsCertificateKeyFile', tlsActive ? fields.tlsCertificateKeyFile : '')
  setParam(cs, 'tlsAllowInvalidCertificates', tlsActive && fields.tlsAllowInvalidCertificates)
  setParam(cs, 'tlsAllowInvalidHostnames', tlsActive && fields.tlsAllowInvalidHostnames)
  cs.searchParams.delete('tlsInsecure')
  setParam(cs, 'replicaSet', fields.replicaSet)
  setParam(cs, 'readPreference', fields.readPreference)
  setParam(cs, 'appName', fields.appName)
  return cs.toString()
}

/** Returns the URI with the password removed, plus the decoded password. */
export function stripPassword(uri: string): { uri: string; password: string } {
  const cs = parseConnectionString(uri)
  const password = decodeURIComponent(cs.password)
  cs.password = ''
  return { uri: cs.toString(), password }
}

export function setPassword(uri: string, password: string): string {
  const cs = parseConnectionString(uri)
  if (cs.username) cs.password = encodeURIComponent(password)
  return cs.toString()
}

/** Hides credentials for display/logging. */
export function redactUri(uri: string): string {
  try {
    return parseConnectionString(uri).redact().toString()
  } catch {
    return '<invalid connection string>'
  }
}

/** A short label: first host (without port for SRV) or "localhost:27017". */
export function connectionLabel(uri: string): string {
  try {
    const cs = parseConnectionString(uri)
    const first = cs.hosts[0] ?? 'localhost'
    return cs.hosts.length > 1 ? `${first} +${cs.hosts.length - 1}` : first
  } catch {
    return 'Invalid connection'
  }
}

export function validateUri(uri: string): string | null {
  if (!/^mongodb(\+srv)?:\/\//.test(uri.trim()))
    return 'Connection string must start with mongodb:// or mongodb+srv://'
  try {
    const cs = new ConnectionString(uri.trim())
    if (cs.isSRV && cs.hosts.length !== 1) return 'mongodb+srv:// takes exactly one host name'
    if (cs.isSRV && /:\d+$/.test(cs.hosts[0] ?? '')) return 'mongodb+srv:// host names cannot have a port'
    return null
  } catch (e) {
    return (e as Error).message
  }
}

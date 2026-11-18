/**
 * Connection model shared by main and renderer.
 *
 * Everything that isn't a secret lives in the connection string (including TLS file paths and
 * driver options), so the "connection string" and "fields" modes of the form edit one value.
 * Secrets (password, key passphrases, SSH password) never come back to the renderer once saved.
 */
import { z } from 'zod'

export const sshSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  authMethod: z.enum(['password', 'privateKey']),
  privateKeyFile: z.string().optional()
})
export type SshConfig = z.infer<typeof sshSchema>

/** Secrets the renderer may send when creating/updating a connection. `undefined` = keep existing. */
export const connectionSecretsSchema = z.object({
  sshPassword: z.string().optional(),
  sshPassphrase: z.string().optional(),
  tlsCertificateKeyFilePassword: z.string().optional()
})
export type ConnectionSecrets = z.infer<typeof connectionSecretsSchema>

export const connectionColors = ['none', 'green', 'blue', 'purple', 'orange', 'red', 'gray'] as const
export type ConnectionColor = (typeof connectionColors)[number]

/** What the renderer sends to save or test a connection. The URI may contain a password. */
export const connectionDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(200).default(''),
  color: z.enum(connectionColors).default('none'),
  folder: z.string().max(200).default(''),
  uri: z.string().min(1, 'Connection string is required'),
  /**
   * When editing a saved connection whose URI comes back with the password stripped, the form
   * sends `keepPassword: true` so the stored password is reused.
   */
  keepPassword: z.boolean().default(false),
  ssh: sshSchema.nullable().default(null),
  secrets: connectionSecretsSchema.default({}),
  readOnly: z.boolean().default(false),
  production: z.boolean().default(false),
  serverSelectionTimeoutMS: z.number().int().min(500).max(120_000).default(10_000)
})
export type ConnectionDraft = z.input<typeof connectionDraftSchema>
export type ParsedConnectionDraft = z.output<typeof connectionDraftSchema>

/** A saved connection as the renderer sees it: no secrets, only flags saying they exist. */
export interface SavedConnection {
  id: string
  name: string
  color: ConnectionColor
  folder: string
  /** Password stripped. */
  uri: string
  ssh: SshConfig | null
  readOnly: boolean
  production: boolean
  serverSelectionTimeoutMS: number
  hasPassword: boolean
  hasSecrets: { sshPassword: boolean; sshPassphrase: boolean; tlsCertificateKeyFilePassword: boolean }
  createdAt: number
  lastUsedAt: number | null
}

export type Topology = 'standalone' | 'replicaSet' | 'sharded' | 'loadBalanced' | 'unknown'

export interface ServerInfo {
  version: string
  topology: Topology
  isAtlas: boolean
  isLocalAtlas: boolean
  isEnterprise: boolean
  replicaSetName: string | null
  /** Round trip of a `ping`, in milliseconds. */
  latencyMs: number
  host: string
  /** True when connected (directly) to a secondary or with a non-primary read preference. */
  isSecondaryRead: boolean
}

export interface ActiveConnection {
  id: string
  server: ServerInfo
  connectedAt: number
}

export interface DatabaseInfo {
  name: string
  sizeOnDisk: number | null
  empty: boolean | null
}

export type CollectionType = 'collection' | 'view' | 'timeseries'

export interface CollectionInfo {
  name: string
  type: CollectionType
  /** estimatedDocumentCount; null for views, or when the count failed or timed out. */
  count: number | null
  capped: boolean
  /** For views: source collection and pipeline length. */
  viewOn: string | null
}

export const namespaceSchema = z.object({
  connectionId: z.string().min(1),
  db: z.string().min(1).max(64)
})

/** Valid MongoDB database name (server rules, cross-platform). */
export function validateDatabaseName(name: string): string | null {
  if (!name) return 'Database name is required'
  if (name.length > 63) return 'Database name must be shorter than 64 characters'
  if (/[/\\. "$*<>:|?\0]/.test(name)) return 'Database name cannot contain / \\ . " $ * < > : | ? or spaces'
  return null
}

export function validateCollectionName(name: string): string | null {
  if (!name) return 'Collection name is required'
  if (name.includes('$')) return 'Collection name cannot contain $'
  if (name.includes('\0')) return 'Collection name cannot contain null characters'
  if (name.startsWith('system.')) return 'Collection names starting with "system." are reserved'
  if (name.startsWith('.') || name.endsWith('.')) return 'Collection name cannot start or end with a dot'
  return null
}

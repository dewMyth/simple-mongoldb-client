/** Wires the Electron-backed singletons. Services themselves stay Electron-free. */
import { safeStorage } from 'electron'
import type { Workspace } from '@shared/workspace'
import { WorkspaceService } from './workspace-service'
import { AggregationService } from './aggregation-service'
import { IndexService } from './index-service'
import { ExplainService } from './explain-service'
import { PipelineLibrary } from './pipeline-library'
import type { SavedPipeline } from '@shared/pipeline'
import Store from 'electron-store'
import { ConnectionManager } from './connection-manager'
import { DatabaseService } from './database-service'
import { CursorRegistry } from './cursor-registry'
import { PermissionService } from './permission-service'
import { HistoryService, type HistoryData } from './history-service'
import { QueryService } from './query-service'
import { SchemaService } from './schema-service'
import { DocumentService } from './document-service'
import { StorageService, type SecretCipher, type StoredConnection } from './storage-service'

const safeStorageCipher: SecretCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64'))
}

const connectionsStore = new Store<{ connections: StoredConnection[] }>({
  name: 'connections',
  defaults: { connections: [] }
})

export const storage = new StorageService(
  {
    get: () => connectionsStore.get('connections'),
    set: (v) => connectionsStore.set('connections', v)
  },
  safeStorageCipher
)
export const connections = new ConnectionManager()
export const databases = new DatabaseService(connections)
export const permissions = new PermissionService()
export const cursors = new CursorRegistry()
export const queries = new QueryService(connections, cursors)
export const schemas = new SchemaService(connections, cursors)
export const documents = new DocumentService(connections)

// Namespaces contain dots, so everything lives under one key (no dot-path access).
const historyStore = new Store<{ data: HistoryData }>({
  name: 'query-history',
  defaults: { data: { history: {}, favorites: [] } }
})
export const history = new HistoryService({
  get: () => historyStore.get('data'),
  set: (d) => historyStore.set('data', d)
})

const workspaceStore = new Store<{ workspace: Workspace | null }>({
  name: 'workspace',
  defaults: { workspace: null }
})
export const workspace = new WorkspaceService({
  get: () => workspaceStore.get('workspace'),
  set: (w) => workspaceStore.set('workspace', w)
})

export const aggregations = new AggregationService(connections, cursors)
const pipelineStore = new Store<{ pipelines: SavedPipeline[] }>({
  name: 'pipelines',
  defaults: { pipelines: [] }
})
export const pipelineLibrary = new PipelineLibrary({
  get: () => pipelineStore.get('pipelines'),
  set: (p) => pipelineStore.set('pipelines', p)
})
export const indexes = new IndexService(connections)
export const explains = new ExplainService(connections, cursors)

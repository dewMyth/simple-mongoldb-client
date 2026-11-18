/** Wires the Electron-backed singletons. Services themselves stay Electron-free. */
import { safeStorage } from 'electron'
import Store from 'electron-store'
import { ConnectionManager } from './connection-manager'
import { DatabaseService } from './database-service'
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

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KeyValueStore, SecretCipher, StoredConnection } from '../../src/main/services/storage-service'
import { StorageService } from '../../src/main/services/storage-service'

/** Reversible fake cipher (XOR + base64) so tests can prove secrets aren't stored in plaintext. */
export const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)).toString('base64'),
  decrypt: (s) => Buffer.from([...Buffer.from(s, 'base64')].map((b) => b ^ 0x5a)).toString()
}

export function fileStore(): { store: KeyValueStore<StoredConnection[]>; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'ms-store-')), 'connections.json')
  return {
    file,
    store: {
      get: () => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as StoredConnection[]) : []),
      set: (v) => writeFileSync(file, JSON.stringify(v, null, 2))
    }
  }
}

export function makeStorage() {
  const { store, file } = fileStore()
  return { storage: new StorageService(store, fakeCipher), file }
}

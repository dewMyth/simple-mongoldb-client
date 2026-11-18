/**
 * Saved connections. Non-secret fields are stored as JSON; secrets (password, SSH password/passphrase,
 * TLS key password) are encrypted with a SecretCipher (Electron safeStorage in the app) and never
 * returned to the renderer.
 */
import { randomUUID } from 'node:crypto'
import {
  connectionDraftSchema,
  type ConnectionDraft,
  type ConnectionSecrets,
  type SavedConnection
} from '@shared/connection'
import { connectionLabel, setPassword, stripPassword } from '@shared/connection-fields'

export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plain: string): string
  decrypt(cipherText: string): string
}

export interface KeyValueStore<T> {
  get(): T
  set(value: T): void
}

interface StoredSecrets extends ConnectionSecrets {
  password?: string
}

export interface StoredConnection extends Omit<SavedConnection, 'hasPassword' | 'hasSecrets'> {
  /** Encrypted JSON of StoredSecrets, or null if there are none. */
  secrets: string | null
}

/** Everything main needs to actually connect. Never sent to the renderer. */
export interface ResolvedConnection {
  id: string
  name: string
  uri: string
  ssh: SavedConnection['ssh']
  secrets: StoredSecrets
  readOnly: boolean
  serverSelectionTimeoutMS: number
}

export class SecretsUnavailableError extends Error {
  override name = 'SecretsUnavailableError'
  constructor() {
    super(
      'Secure storage (OS keychain) is not available, so passwords cannot be saved. ' +
        'Remove the password from the connection or enable a keyring.'
    )
  }
}

export class StorageService {
  constructor(
    private readonly store: KeyValueStore<StoredConnection[]>,
    private readonly cipher: SecretCipher
  ) {}

  private all(): StoredConnection[] {
    return this.store.get() ?? []
  }

  private readSecrets(c: StoredConnection): StoredSecrets {
    if (!c.secrets) return {}
    try {
      return JSON.parse(this.cipher.decrypt(c.secrets)) as StoredSecrets
    } catch {
      return {} // keychain reset or moved machines: treat as no secrets
    }
  }

  private toPublic(c: StoredConnection): SavedConnection {
    const s = this.readSecrets(c)
    const { secrets: _secrets, ...rest } = c
    return {
      ...rest,
      hasPassword: !!s.password,
      hasSecrets: {
        sshPassword: !!s.sshPassword,
        sshPassphrase: !!s.sshPassphrase,
        tlsCertificateKeyFilePassword: !!s.tlsCertificateKeyFilePassword
      }
    }
  }

  list(): SavedConnection[] {
    return this.all().map((c) => this.toPublic(c))
  }

  get(id: string): SavedConnection | null {
    const c = this.all().find((x) => x.id === id)
    return c ? this.toPublic(c) : null
  }

  /** Merges draft secrets over stored ones. Shared by save() and test-before-save. */
  mergeSecrets(draftInput: ConnectionDraft): { uri: string; secrets: StoredSecrets } {
    const draft = connectionDraftSchema.parse(draftInput)
    const existing = draft.id ? this.all().find((c) => c.id === draft.id) : undefined
    const old = existing ? this.readSecrets(existing) : {}
    const { uri, password } = stripPassword(draft.uri.trim())
    const secrets: StoredSecrets = {
      password: password || (draft.keepPassword ? old.password : undefined),
      sshPassword: draft.secrets.sshPassword ?? old.sshPassword,
      sshPassphrase: draft.secrets.sshPassphrase ?? old.sshPassphrase,
      tlsCertificateKeyFilePassword:
        draft.secrets.tlsCertificateKeyFilePassword ?? old.tlsCertificateKeyFilePassword
    }
    // Drop SSH secrets if SSH was turned off, and empty strings everywhere.
    if (!draft.ssh) {
      delete secrets.sshPassword
      delete secrets.sshPassphrase
    }
    for (const k of Object.keys(secrets) as (keyof StoredSecrets)[]) if (!secrets[k]) delete secrets[k]
    return { uri, secrets }
  }

  save(draftInput: ConnectionDraft): SavedConnection {
    const draft = connectionDraftSchema.parse(draftInput)
    const { uri, secrets } = this.mergeSecrets(draft)
    const hasSecrets = Object.keys(secrets).length > 0
    if (hasSecrets && !this.cipher.isAvailable()) throw new SecretsUnavailableError()

    const list = this.all()
    const idx = draft.id ? list.findIndex((c) => c.id === draft.id) : -1
    const prev = idx >= 0 ? list[idx] : undefined
    const record: StoredConnection = {
      id: prev?.id ?? draft.id ?? randomUUID(),
      name: draft.name.trim() || connectionLabel(uri),
      color: draft.color,
      folder: draft.folder.trim(),
      uri,
      ssh: draft.ssh,
      readOnly: draft.readOnly,
      production: draft.production,
      serverSelectionTimeoutMS: draft.serverSelectionTimeoutMS,
      createdAt: prev?.createdAt ?? Date.now(),
      lastUsedAt: prev?.lastUsedAt ?? null,
      secrets: hasSecrets ? this.cipher.encrypt(JSON.stringify(secrets)) : null
    }
    if (idx >= 0) list[idx] = record
    else list.push(record)
    this.store.set(list)
    return this.toPublic(record)
  }

  setReadOnly(id: string, readOnly: boolean): SavedConnection {
    const list = this.all()
    const c = list.find((x) => x.id === id)
    if (!c) throw new Error(`Unknown connection: ${id}`)
    c.readOnly = readOnly
    this.store.set(list)
    return this.toPublic(c)
  }

  delete(id: string): void {
    this.store.set(this.all().filter((c) => c.id !== id))
  }

  touch(id: string): void {
    const list = this.all()
    const c = list.find((x) => x.id === id)
    if (c) {
      c.lastUsedAt = Date.now()
      this.store.set(list)
    }
  }

  /** Full connection details for main-process use only. */
  resolve(id: string): ResolvedConnection {
    const c = this.all().find((x) => x.id === id)
    if (!c) throw new Error(`Unknown connection: ${id}`)
    const secrets = this.readSecrets(c)
    return {
      id: c.id,
      name: c.name,
      uri: secrets.password ? setPassword(c.uri, secrets.password) : c.uri,
      ssh: c.ssh,
      secrets,
      readOnly: c.readOnly,
      serverSelectionTimeoutMS: c.serverSelectionTimeoutMS
    }
  }

  /** Resolves an unsaved draft (for "Test connection"), reusing stored secrets when editing. */
  resolveDraft(draftInput: ConnectionDraft): ResolvedConnection {
    const draft = connectionDraftSchema.parse(draftInput)
    const { uri, secrets } = this.mergeSecrets(draft)
    return {
      id: draft.id ?? 'draft',
      name: draft.name,
      uri: secrets.password ? setPassword(uri, secrets.password) : uri,
      ssh: draft.ssh,
      secrets,
      readOnly: draft.readOnly,
      serverSelectionTimeoutMS: draft.serverSelectionTimeoutMS
    }
  }
}

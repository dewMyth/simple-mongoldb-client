/**
 * One MongoClient per open connection id (plus an optional SSH tunnel). The only place clients
 * are created. Electron-free so it can be integration-tested directly.
 */
import { MongoClient, type MongoClientOptions } from 'mongodb'
import type { ActiveConnection, ServerInfo, Topology } from '@shared/connection'
import { parseConnectionString } from '@shared/connection-fields'
import type { ResolvedConnection } from './storage-service'
import { openSshTunnel, type SshTunnel } from './ssh-tunnel'
import { ReadableError } from './errors'

interface OpenConnection {
  id: string
  client: MongoClient
  tunnel?: SshTunnel
  resolved: ResolvedConnection
  info: ActiveConnection
}

const ATLAS_HOST = /\.mongodb(-dev|-qa|-stage)?\.net$/i

export class ConnectionManager {
  private readonly open = new Map<string, OpenConnection>()
  private readonly pending = new Map<string, Promise<ActiveConnection>>()
  private listeners = new Set<(ids: string[]) => void>()

  onChange(listener: (ids: string[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    const ids = [...this.open.keys()]
    for (const l of this.listeners) l(ids)
  }

  /** Builds a client (and tunnel) without registering it. */
  private async createClient(
    resolved: ResolvedConnection
  ): Promise<{ client: MongoClient; tunnel?: SshTunnel }> {
    let uri = resolved.uri
    let tunnel: SshTunnel | undefined
    const options: MongoClientOptions = {
      serverSelectionTimeoutMS: resolved.serverSelectionTimeoutMS,
      connectTimeoutMS: resolved.serverSelectionTimeoutMS,
      appName: 'Mongo Studio'
    }
    const cs = parseConnectionString(uri)
    if (cs.searchParams.get('appName')) delete options.appName
    if (resolved.secrets.tlsCertificateKeyFilePassword) {
      options.tlsCertificateKeyFilePassword = resolved.secrets.tlsCertificateKeyFilePassword
    }

    if (resolved.ssh) {
      if (cs.isSRV) {
        throw new Error(
          'mongodb+srv:// cannot be used through an SSH tunnel. Use a mongodb:// string with one member host.'
        )
      }
      const [host, portStr] = (cs.hosts[0] ?? 'localhost:27017').split(/:(?=\d+$)/)
      tunnel = await openSshTunnel(
        resolved.ssh,
        resolved.secrets,
        { host: host!, port: Number(portStr ?? 27017) },
        resolved.serverSelectionTimeoutMS
      )
      cs.hosts = [`127.0.0.1:${tunnel.localPort}`]
      cs.searchParams.set('directConnection', 'true')
      // Certificates are issued for the real host name, not 127.0.0.1.
      if (cs.searchParams.get('tls') === 'true' || cs.searchParams.get('ssl') === 'true')
        options.servername = host
      uri = cs.toString()
    }

    const client = new MongoClient(uri, options)
    try {
      await client.connect()
    } catch (err) {
      await client.close().catch(() => {})
      await tunnel?.close().catch(() => {})
      throw err
    }
    return { client, tunnel }
  }

  private async describe(client: MongoClient, resolved: ResolvedConnection): Promise<ServerInfo> {
    const admin = client.db('admin')
    const t0 = performance.now()
    await admin.command({ ping: 1 })
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10
    const [hello, buildInfo] = await Promise.all([
      admin.command({ hello: 1 }),
      admin.command({ buildInfo: 1 }).catch(() => ({}) as Record<string, unknown>)
    ])

    let topology: Topology = 'standalone'
    if (hello['msg'] === 'isdbgrid') topology = 'sharded'
    else if (hello['setName']) topology = 'replicaSet'
    else if (hello['serviceId']) topology = 'loadBalanced'

    const cs = parseConnectionString(resolved.uri)
    const hosts = cs.hosts
    const mode = client.readPreference.mode
    const direct = cs.searchParams.get('directConnection') === 'true'
    return {
      version: String(buildInfo['version'] ?? 'unknown'),
      topology,
      isAtlas: hosts.some((h) => ATLAS_HOST.test(h.replace(/:\d+$/, ''))),
      isLocalAtlas: false,
      isEnterprise:
        Array.isArray(buildInfo['modules']) && (buildInfo['modules'] as string[]).includes('enterprise'),
      replicaSetName: (hello['setName'] as string | undefined) ?? null,
      latencyMs,
      host: String(hello['me'] ?? hosts[0] ?? ''),
      isSecondaryRead: (mode !== 'primary' && mode !== undefined) || (direct && hello['secondary'] === true)
    }
  }

  /** Connects, runs ping + buildInfo + hello, then disconnects. */
  async test(resolved: ResolvedConnection): Promise<ServerInfo> {
    let created: { client: MongoClient; tunnel?: SshTunnel } | undefined
    try {
      created = await this.createClient(resolved)
      return await this.describe(created.client, resolved)
    } catch (err) {
      throw new ReadableError(err)
    } finally {
      await created?.client.close().catch(() => {})
      await created?.tunnel?.close().catch(() => {})
    }
  }

  async connect(resolved: ResolvedConnection): Promise<ActiveConnection> {
    const existing = this.open.get(resolved.id)
    if (existing) return existing.info
    const inFlight = this.pending.get(resolved.id)
    if (inFlight) return inFlight

    const p = (async () => {
      try {
        const { client, tunnel } = await this.createClient(resolved)
        try {
          const server = await this.describe(client, resolved)
          const info: ActiveConnection = { id: resolved.id, server, connectedAt: Date.now() }
          this.open.set(resolved.id, { id: resolved.id, client, tunnel, resolved, info })
          this.emit()
          return info
        } catch (err) {
          await client.close().catch(() => {})
          await tunnel?.close().catch(() => {})
          throw err
        }
      } catch (err) {
        throw new ReadableError(err)
      } finally {
        this.pending.delete(resolved.id)
      }
    })()
    this.pending.set(resolved.id, p)
    return p
  }

  async disconnect(id: string): Promise<void> {
    const c = this.open.get(id)
    if (!c) return
    this.open.delete(id)
    this.emit()
    await c.client.close().catch(() => {})
    await c.tunnel?.close().catch(() => {})
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.disconnect(id)))
  }

  client(id: string): MongoClient {
    const c = this.open.get(id)
    if (!c) throw new Error('Not connected. Open the connection first.')
    return c.client
  }

  info(id: string): ActiveConnection | null {
    return this.open.get(id)?.info ?? null
  }

  resolved(id: string): ResolvedConnection | null {
    return this.open.get(id)?.resolved ?? null
  }

  active(): ActiveConnection[] {
    return [...this.open.values()].map((c) => c.info)
  }

  isOpen(id: string): boolean {
    return this.open.has(id)
  }
}

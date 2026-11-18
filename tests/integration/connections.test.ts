import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import { readFileSync } from 'node:fs'
import { ConnectionManager } from '../../src/main/services/connection-manager'
import { DatabaseService } from '../../src/main/services/database-service'
import { makeStorage } from './helpers'

let standalone: MongoMemoryServer
let replset: MongoMemoryReplSet
const manager = new ConnectionManager()
const dbs = new DatabaseService(manager)

async function seed(uri: string) {
  const c = new MongoClient(uri)
  await c.connect()
  await c
    .db('shop')
    .collection('orders')
    .insertMany([{ n: 1 }, { n: 2 }, { n: 3 }])
  await c.db('shop').collection('customers').insertOne({ name: 'a' })
  await c
    .db('shop')
    .createCollection('bigOrders', { viewOn: 'orders', pipeline: [{ $match: { n: { $gt: 1 } } }] })
  await c.db('other').collection('things').insertOne({ x: 1 })
  await c.close()
}

beforeAll(async () => {
  ;[standalone, replset] = await Promise.all([
    MongoMemoryServer.create(),
    MongoMemoryReplSet.create({ replSet: { count: 1 } })
  ])
  await Promise.all([seed(standalone.getUri()), seed(replset.getUri())])
})

afterAll(async () => {
  await manager.disconnectAll()
  await Promise.all([standalone?.stop(), replset?.stop()])
})

describe('connections', () => {
  it('connects to a standalone server and lists databases and collections', async () => {
    const { storage } = makeStorage()
    const saved = storage.save({ name: 'local', uri: standalone.getUri() })
    const info = await manager.connect(storage.resolve(saved.id))
    expect(info.server.topology).toBe('standalone')
    expect(info.server.version).toMatch(/^\d+\.\d+/)
    expect(info.server.latencyMs).toBeGreaterThanOrEqual(0)

    const names = (await dbs.listDatabases(saved.id)).map((d) => d.name)
    expect(names).toEqual(expect.arrayContaining(['admin', 'other', 'shop']))

    const colls = await dbs.listCollections(saved.id, 'shop')
    expect(colls.find((c) => c.name === 'orders')).toMatchObject({ type: 'collection', count: 3 })
    expect(colls.find((c) => c.name === 'customers')).toMatchObject({ count: 1 })
    expect(colls.find((c) => c.name === 'bigOrders')).toMatchObject({
      type: 'view',
      count: null,
      viewOn: 'orders'
    })
  })

  it('connects to a replica set', async () => {
    const { storage } = makeStorage()
    const saved = storage.save({ name: 'rs', uri: replset.getUri() })
    const info = await manager.connect(storage.resolve(saved.id))
    expect(info.server.topology).toBe('replicaSet')
    expect(info.server.replicaSetName).toBeTruthy()
    expect((await dbs.listCollections(saved.id, 'other')).map((c) => c.name)).toEqual(['things'])
  })

  it('keeps two connections open side by side', async () => {
    const { storage } = makeStorage()
    const a = storage.save({ name: 'a', uri: standalone.getUri() })
    const b = storage.save({ name: 'b', uri: replset.getUri() })
    await Promise.all([manager.connect(storage.resolve(a.id)), manager.connect(storage.resolve(b.id))])
    const [la, lb] = await Promise.all([dbs.listCollections(a.id, 'shop'), dbs.listCollections(b.id, 'shop')])
    expect(la.length).toBe(3)
    expect(lb.length).toBe(3)
    expect(manager.isOpen(a.id) && manager.isOpen(b.id)).toBe(true)
    await manager.disconnect(a.id)
    expect(manager.isOpen(a.id)).toBe(false)
    expect(manager.isOpen(b.id)).toBe(true)
  })

  it('creates and drops databases and collections', async () => {
    const { storage } = makeStorage()
    const s = storage.save({ uri: standalone.getUri() })
    await manager.connect(storage.resolve(s.id))
    await dbs.createDatabase(s.id, 'newdb', 'first')
    await dbs.createCollection(s.id, 'newdb', 'capped', { capped: { size: 4096, max: 10 } })
    const colls = await dbs.listCollections(s.id, 'newdb')
    expect(colls.map((c) => c.name)).toEqual(['capped', 'first'])
    expect(colls[0]!.capped).toBe(true)
    await dbs.dropCollection(s.id, 'newdb', 'capped')
    await dbs.dropDatabase(s.id, 'newdb')
    expect((await dbs.listDatabases(s.id)).map((d) => d.name)).not.toContain('newdb')
    await expect(dbs.createCollection(s.id, 'bad/name', 'x')).rejects.toThrow(/cannot contain/)
  })

  it('shows a readable error for an unreachable host within the timeout', async () => {
    const { storage } = makeStorage()
    const s = storage.save({ uri: 'mongodb://127.0.0.1:1/', serverSelectionTimeoutMS: 1500 })
    const t0 = Date.now()
    await expect(manager.test(storage.resolve(s.id))).rejects.toThrow(/Connection refused/)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('shows a readable error for an unknown host', async () => {
    const { storage } = makeStorage()
    const s = storage.save({ uri: 'mongodb://no-such-host.invalid:27017/', serverSelectionTimeoutMS: 1500 })
    await expect(manager.test(storage.resolve(s.id))).rejects.toThrow(/Host not found/)
  })
})

describe('saved connection storage', () => {
  it('never writes secrets in plaintext and never returns them', () => {
    const { storage, file } = makeStorage()
    const saved = storage.save({
      name: 'prod',
      uri: 'mongodb://alice:Sup3r-S3cret!@db.example.com:27017/?authSource=admin',
      ssh: { host: 'bastion', port: 22, username: 'ec2', authMethod: 'password' },
      secrets: { sshPassword: 'Ssh-Pa55word', tlsCertificateKeyFilePassword: 'K3y-Pa55' }
    })
    const disk = readFileSync(file, 'utf8')
    for (const secret of ['Sup3r-S3cret', 'Ssh-Pa55word', 'K3y-Pa55']) {
      expect(disk).not.toContain(secret)
      expect(disk).not.toContain(encodeURIComponent(secret))
      expect(JSON.stringify(storage.list())).not.toContain(secret)
    }
    expect(saved.uri).toBe('mongodb://alice@db.example.com:27017/?authSource=admin')
    expect(saved.hasPassword).toBe(true)
    expect(saved.hasSecrets).toEqual({
      sshPassword: true,
      sshPassphrase: false,
      tlsCertificateKeyFilePassword: true
    })
    // ...but main can still resolve the full URI.
    expect(storage.resolve(saved.id).uri).toContain('alice:Sup3r-S3cret!@')
  })

  it('keeps the stored password when an edit sends the stripped URI', () => {
    const { storage } = makeStorage()
    const s = storage.save({ uri: 'mongodb://u:pw@h/' })
    storage.save({ id: s.id, uri: s.uri, keepPassword: true, name: 'renamed' })
    expect(storage.resolve(s.id).uri).toBe('mongodb://u:pw@h/')
    storage.save({ id: s.id, uri: s.uri, keepPassword: false })
    expect(storage.resolve(s.id).uri).toBe('mongodb://u@h/')
  })
})

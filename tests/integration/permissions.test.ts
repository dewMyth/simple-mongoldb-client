import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { ConnectionManager } from '../../src/main/services/connection-manager'
import { DatabaseService } from '../../src/main/services/database-service'
import { PermissionService } from '../../src/main/services/permission-service'
import { collectionActions, databaseActions, type PermissionAction } from '../../src/shared/permissions'
import { seedUsers, TEST_PASSWORD } from '../../scripts/seed-users'
import { makeStorage } from './helpers'

let server: MongoMemoryServer
let root: MongoClient
let port: number
const manager = new ConnectionManager()
const dbs = new DatabaseService(manager)

beforeAll(async () => {
  server = await MongoMemoryServer.create({
    auth: { enable: true, customRootName: 'root', customRootPwd: 'rootpw' }
  })
  port = server.instanceInfo!.port
  root = await MongoClient.connect(`mongodb://root:rootpw@127.0.0.1:${port}/?authSource=admin`)
  await seedUsers(root)
})

afterAll(async () => {
  await manager.disconnectAll()
  await root?.close()
  await server?.stop()
})

async function connectAs(user: string, permissions = new PermissionService(), readOnly = false) {
  const { storage } = makeStorage()
  const s = storage.save({
    uri: `mongodb://${user}:${TEST_PASSWORD}@127.0.0.1:${port}/?authSource=admin`,
    readOnly
  })
  const info = await manager.connect(storage.resolve(s.id))
  const snapshot = await permissions.load(s.id, manager.client(s.id), info.server, readOnly)
  return { id: s.id, permissions, snapshot }
}

/** Enabled actions: database-level for "db", collection-level for "db.coll". */
function allowed(p: PermissionService, id: string, ns: string): PermissionAction[] {
  return (ns.includes('.') ? collectionActions : databaseActions).filter((a) => p.check(id, ns, a).allowed)
}

describe('privilege matrix per user', () => {
  it('read on shop: find only, and only on shop', async () => {
    const { id, permissions, snapshot } = await connectAs('reader')
    expect(snapshot.mode).toBe('privileges')
    expect(snapshot.roles).toEqual([{ role: 'read', db: 'shop' }])
    expect(allowed(permissions, id, 'shop.orders')).toEqual(['find'])
    expect(allowed(permissions, id, 'shop')).toEqual([])
    expect(allowed(permissions, id, 'logs.events')).toEqual([])
    expect(permissions.check(id, 'shop.orders', 'insert').reason).toBe(
      'reader lacks `insert` on `shop.orders`.'
    )
  })

  it('readWrite on shop: read and write documents, manage collections and indexes', async () => {
    const { id, permissions } = await connectAs('writer')
    expect(allowed(permissions, id, 'shop.orders')).toEqual([
      'find',
      'insert',
      'update',
      'remove',
      'createIndex',
      'dropIndex',
      'createCollection',
      'dropCollection'
    ])
    // collMod comes from dbAdmin, not readWrite.
    expect(allowed(permissions, id, 'shop')).toEqual(['createCollection'])
    expect(allowed(permissions, id, 'logs.events')).toEqual([])
  })

  it('dbAdmin on logs: administer collections but not read or write documents', async () => {
    const { id, permissions } = await connectAs('dba')
    expect(allowed(permissions, id, 'logs.events')).toEqual([
      'createIndex',
      'dropIndex',
      'createCollection',
      'dropCollection',
      'collMod'
    ])
    expect(allowed(permissions, id, 'logs')).toEqual(['createCollection', 'dropDatabase'])
    expect(permissions.check(id, 'logs.system.profile', 'find').allowed).toBe(true)
    expect(allowed(permissions, id, 'shop.orders')).toEqual([])
  })

  it('the matrix agrees with the server', async () => {
    const { id, permissions } = await connectAs('writer')
    // Allowed by the matrix → the server accepts.
    await permissions.guard(id, 'shop.tmp', 'createCollection', () => dbs.createCollection(id, 'shop', 'tmp'))
    await permissions.guard(id, 'shop.tmp', 'dropCollection', () => dbs.dropCollection(id, 'shop', 'tmp'))
    // Denied by the matrix → refused before reaching the server.
    await expect(
      permissions.guard(id, 'shop', 'dropDatabase', () => dbs.dropDatabase(id, 'shop'))
    ).rejects.toThrow('writer lacks `dropDatabase` on `shop`.')
    expect(await root.db('shop').collection('orders').countDocuments()).toBe(2)
  })
})

describe('read-only override', () => {
  it('blocks every write even for a user who could write, but still allows reads', async () => {
    const { id, permissions } = await connectAs('writer', new PermissionService(), true)
    expect(allowed(permissions, id, 'shop.orders')).toEqual(['find'])
    await expect(
      permissions.guard(id, 'shop.orders', 'dropCollection', () => dbs.dropCollection(id, 'shop', 'orders'))
    ).rejects.toThrow(/Read-only mode/)
    permissions.setReadOnly(id, false)
    expect(permissions.check(id, 'shop.orders', 'dropCollection').allowed).toBe(true)
  })
})

describe('optimistic mode', () => {
  it('falls back when connectionStatus fails, then disables an action the server rejects', async () => {
    const permissions = new PermissionService(async () => {
      throw Object.assign(new Error('command not supported by this proxy'), { code: 59 })
    })
    const { id, snapshot } = await connectAs('reader', permissions)
    expect(snapshot.mode).toBe('optimistic')
    expect(snapshot.statusError).toMatch(/not supported/)
    expect(permissions.check(id, 'shop.orders', 'dropCollection').allowed).toBe(true)

    const events: string[] = []
    permissions.onChange((s) => events.push(s.mode))
    await expect(
      permissions.guard(id, 'shop.orders', 'dropCollection', () => dbs.dropCollection(id, 'shop', 'orders'))
    ).rejects.toMatchObject({ code: 13 })

    const check = permissions.check(id, 'shop.orders', 'dropCollection')
    expect(check.allowed).toBe(false)
    expect(check.reason).toMatch(/server rejected `dropCollection` on `shop.orders` \(Unauthorized\)/)
    expect(events).toEqual(['optimistic'])
    // Other actions and namespaces are unaffected.
    expect(permissions.check(id, 'shop.other', 'dropCollection').allowed).toBe(true)
  })

  it('treats a server without auth as allow-all', async () => {
    const plain = await MongoMemoryServer.create()
    try {
      const { storage } = makeStorage()
      const s = storage.save({ uri: plain.getUri() })
      const info = await manager.connect(storage.resolve(s.id))
      const p = new PermissionService()
      expect((await p.load(s.id, manager.client(s.id), info.server, false)).mode).toBe('noAuth')
      expect(p.check(s.id, 'any', 'dropDatabase').allowed).toBe(true)
      await manager.disconnect(s.id)
    } finally {
      await plain.stop()
    }
  })
})

describe('secondary reads', () => {
  it('a non-primary readPreference makes the connection read-only', async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server')
    const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    try {
      const uri = new URL(rs.getUri())
      uri.searchParams.set('readPreference', 'secondaryPreferred')
      const { storage } = makeStorage()
      const s = storage.save({ uri: uri.toString() })
      const info = await manager.connect(storage.resolve(s.id))
      expect(info.server.isSecondaryRead).toBe(true)
      const p = new PermissionService()
      const snap = await p.load(s.id, manager.client(s.id), info.server, false)
      expect(snap.secondaryReason).toMatch(/reads from a secondary/)
      expect(p.check(s.id, 'a.b', 'insert').allowed).toBe(false)
      expect(p.check(s.id, 'a.b', 'find').allowed).toBe(true)
      await manager.disconnect(s.id)
    } finally {
      await rs.stop()
    }
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { ConnectionManager } from '../../src/main/services/connection-manager'
import { CursorRegistry } from '../../src/main/services/cursor-registry'
import { QueryService } from '../../src/main/services/query-service'
import { SchemaService } from '../../src/main/services/schema-service'
import { BSON } from 'bson'
import { fromBsonBytes } from '../../src/shared/bson-wire'
import { allTypesDoc, ALL_TYPES_ID } from '../fixtures/all-types'
import { emptyQueryText, type QueryText } from '../../src/shared/query'
import { makeStorage } from './helpers'

let server: MongoMemoryServer
let admin: MongoClient
let connId: string
const manager = new ConnectionManager()
const registry = new CursorRegistry()
const queries = new QueryService(manager, registry)

/** BSON bytes → plain JS values (numbers promoted), for readable assertions. */
const plain = <T>(d: Uint8Array | undefined) => BSON.deserialize(d!) as T
const q = (p: Partial<QueryText>): QueryText => ({ ...emptyQueryText, ...p })

/** Server-side view of our operations: running ops plus idle cursors tagged with our comment prefix. */
async function serverOps() {
  return admin
    .db('admin')
    .aggregate([
      { $currentOp: { allUsers: true, idleCursors: true } },
      {
        $match: {
          $or: [
            { 'command.comment': { $regex: '^mongo-studio:' } },
            { 'cursor.originatingCommand.comment': { $regex: '^mongo-studio:' } }
          ]
        }
      }
    ])
    .toArray()
}

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  const coll = admin.db('shop').collection('orders')
  await coll.insertMany(
    Array.from({ length: 250 }, (_, i) => ({
      i,
      status: i % 5 === 0 ? 'new' : 'done',
      createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 28)))
    }))
  )
  const { storage } = makeStorage()
  connId = storage.save({ uri: server.getUri() }).id
  await manager.connect(storage.resolve(connId))
})

afterEach(async () => {
  // A failed assertion must not leave cursors open for the next test.
  await registry.cancelAll()
})

afterAll(async () => {
  await registry.cancelAll()
  await manager.disconnectAll()
  await admin?.close()
  await server?.stop()
})

describe('query service', () => {
  it('streams batches with getMore until exhausted', async () => {
    const first = await queries.find({
      connectionId: connId,
      ns: 'shop.orders',
      query: q({ sort: '{ i: 1 }' }),
      batchSize: 100
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.docs).toHaveLength(100)
    expect(first.exhausted).toBe(false)
    expect(plain<{ i: number }>(first.docs[0]).i).toBe(0)

    const second = await queries.getMore(first.cursorId, 100)
    expect(second.docs).toHaveLength(100)
    expect(plain<{ i: number }>(second.docs[0]).i).toBe(100)
    const third = await queries.getMore(first.cursorId, 100)
    expect(third.docs).toHaveLength(50)
    expect(third.exhausted).toBe(true)
    expect(registry.has(first.cursorId)).toBe(false)
  })

  it('fetches a page in one batch, composed with the user skip/limit, leaving no cursor open', async () => {
    const page = (offset: number, extra: Partial<QueryText> = {}) =>
      queries.find({
        connectionId: connId,
        ns: 'shop.orders',
        query: q({ sort: '{ i: 1 }', ...extra }),
        page: { offset, size: 25 }
      })
    const p3 = await page(50)
    expect(p3.ok && p3.exhausted).toBe(true)
    if (!p3.ok) return
    expect(p3.docs.map((d) => plain<{ i: number }>(d).i)).toEqual(
      Array.from({ length: 25 }, (_, k) => 50 + k)
    )
    expect(registry.size()).toBe(0)
    expect((await serverOps()).length).toBe(0)

    const last = await page(225)
    expect(last.ok && last.docs.length).toBe(25)
    const beyond = await page(250)
    expect(beyond.ok && beyond.docs.length).toBe(0)

    // User skip 10 + limit 40: page 2 holds documents 35..49.
    const user = await page(25, { skip: '10', limit: '40' })
    expect(user.ok && user.docs.map((d) => plain<{ i: number }>(d).i)).toEqual(
      Array.from({ length: 15 }, (_, k) => 35 + k)
    )
  })

  it('applies filter, projection, sort, skip, limit, collation and hint', async () => {
    await admin.db('shop').collection('orders').createIndex({ status: 1 })
    const res = await queries.find({
      connectionId: connId,
      ns: 'shop.orders',
      query: q({
        filter: '{ status: "NEW" }',
        collation: '{ locale: "en", strength: 2 }',
        project: '{ _id: 0, i: 1 }',
        sort: '{ i: -1 }',
        skip: '1',
        limit: '3',
        hint: 'status_1'
      })
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.docs.map((d) => plain(d))).toEqual([{ i: 240 }, { i: 235 }, { i: 230 }])
    expect(res.exhausted).toBe(true)
  })

  it('returns parse errors per field instead of running', async () => {
    const res = await queries.find({
      connectionId: connId,
      ns: 'shop.orders',
      query: q({ filter: '{ a: foo() }', limit: 'x' })
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors.map((e) => e.field)).toEqual(['filter', 'limit'])
  })

  it('reads every BSON type back byte-identical (no promotion to JS numbers)', async () => {
    const doc = allTypesDoc()
    await admin.db('shop').collection('alltypes').insertOne(doc)
    const res = await queries.find({
      connectionId: connId,
      ns: 'shop.alltypes',
      query: q({ filter: `{ _id: ObjectId("${ALL_TYPES_ID.toHexString()}") }` })
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The bytes that cross IPC are exactly what was stored…
    expect(Buffer.from(res.docs[0]!).equals(Buffer.from(BSON.serialize(doc)))).toBe(true)
    // …and decoding keeps every type.
    const back = fromBsonBytes(res.docs[0]!)
    expect(Buffer.from(BSON.serialize(back)).equals(Buffer.from(BSON.serialize(doc)))).toBe(true)
  })

  it('samples fields with types and frequency', async () => {
    const schemas = new SchemaService(manager, registry)
    const sample = await schemas.sampleFields({ connectionId: connId, ns: 'shop.orders', size: 50 })
    expect(sample.sampled).toBe(50)
    const byPath = Object.fromEntries(sample.fields.map((f) => [f.path, f]))
    expect(byPath['_id']!.types[0]!.type).toBe('objectId')
    expect(byPath['i']!.types[0]!.type).toBe('int32')
    expect(byPath['createdAt']!.types).toEqual([{ type: 'date', count: 50 }])
    expect(byPath['status']!.probability).toBe(1)
    expect(registry.size()).toBe(0)
  })

  it('counts: estimated without filter, exact with filter', async () => {
    expect(await queries.count({ connectionId: connId, ns: 'shop.orders', query: q({}) })).toEqual({
      value: 250,
      exact: true,
      method: 'estimated'
    })
    expect(
      await queries.count({
        connectionId: connId,
        ns: 'shop.orders',
        query: q({ filter: '{ status: "new" }' })
      })
    ).toEqual({
      value: 50,
      exact: true,
      method: 'countDocuments'
    })
  })

  it('cancelling a long-running query frees it on the server', async () => {
    // Each document sleeps 50 ms server-side, so the first batch would take ~5 s.
    const pending = queries.find({
      connectionId: connId,
      ns: 'shop.orders',
      tabId: 'tab-long',
      query: q({ filter: '{ $where: "sleep(50) || true" }' })
    })
    const settled = pending.then(
      () => 'resolved',
      (e: Error) => e.name
    )
    await expect.poll(async () => (await serverOps()).length, { timeout: 3000 }).toBeGreaterThan(0)

    const t0 = Date.now()
    expect(await registry.cancelForTab('tab-long')).toBe(1)
    expect(await settled).toBe('CancelledError')
    expect(Date.now() - t0).toBeLessThan(2000)
    await expect.poll(async () => (await serverOps()).length, { timeout: 3000 }).toBe(0)
  })

  it('closing a tab kills its open (idle) cursors on the server', async () => {
    const res = await queries.find({
      connectionId: connId,
      ns: 'shop.orders',
      tabId: 'tab-idle',
      query: q({}),
      batchSize: 50
    })
    expect(res.ok && !res.exhausted).toBe(true)
    expect((await serverOps()).length).toBe(1) // idle cursor waiting for getMore
    await registry.cancelForTab('tab-idle')
    await expect.poll(async () => (await serverOps()).length, { timeout: 3000 }).toBe(0)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, type Document } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { ConnectionManager } from '../../src/main/services/connection-manager'
import { CursorRegistry } from '../../src/main/services/cursor-registry'
import { IndexService } from '../../src/main/services/index-service'
import { ExplainService } from '../../src/main/services/explain-service'
import { emptyCreateIndexForm, type IndexKind } from '../../src/shared/indexes'
import { emptyQueryText } from '../../src/shared/query'
import { emptyPipelineOptions } from '../../src/shared/pipeline'
import { makeStorage } from './helpers'

let server: MongoMemoryServer
let admin: MongoClient
let connId: string
const manager = new ConnectionManager()
const registry = new CursorRegistry()
const indexes = new IndexService(manager)
const explains = new ExplainService(manager, registry)
const NS = 'shop.places'

/** The fixture: one index of every kind the Indexes tab shows. */
const FIXTURE: { key: Document; options?: Document; kinds: IndexKind[] }[] = [
  { key: { name: 1 }, kinds: ['single'] },
  { key: { status: 1, createdAt: -1 }, kinds: ['compound'] },
  { key: { tags: 1 }, kinds: ['single', 'multikey'] },
  {
    key: { description: 'text', name: 'text' },
    options: { name: 'text_idx', weights: { name: 5 } },
    kinds: ['text']
  },
  { key: { location: '2dsphere' }, kinds: ['single', '2dsphere'] },
  { key: { grid: '2d' }, kinds: ['single', '2d'] },
  { key: { userId: 'hashed' }, kinds: ['single', 'hashed'] },
  {
    key: { '$**': 1 },
    options: { name: 'wildcard_all', wildcardProjection: { secret: 0 } },
    kinds: ['wildcard']
  },
  { key: { 'attrs.$**': 1 }, kinds: ['wildcard'] },
  { key: { createdAt: 1 }, options: { expireAfterSeconds: 3600 }, kinds: ['single', 'ttl'] },
  {
    key: { score: 1 },
    options: { partialFilterExpression: { score: { $gt: 10 } } },
    kinds: ['single', 'partial']
  },
  { key: { email: 1 }, options: { unique: true, sparse: true }, kinds: ['single', 'unique', 'sparse'] },
  { key: { legacy: 1 }, options: { hidden: true }, kinds: ['single', 'hidden'] },
  { key: { city: 1 }, options: { collation: { locale: 'fr', strength: 2 } }, kinds: ['single', 'collation'] }
]

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  const places = admin.db('shop').collection('places')
  await places.insertMany(
    Array.from({ length: 50 }, (_, i) => ({
      name: `p${i}`,
      status: i % 2 ? 'open' : 'closed',
      createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
      tags: ['a', 'b'],
      description: 'a nice place',
      location: { type: 'Point', coordinates: [i / 10, i / 20] },
      grid: [i, i],
      userId: i,
      attrs: { color: 'red' },
      score: i,
      email: `u${i}@x.io`,
      legacy: i,
      city: 'Paris'
    }))
  )
  for (const ix of FIXTURE) await places.createIndex(ix.key, ix.options ?? {})
  await places.find({ name: 'p1' }).toArray() // one use, for $indexStats

  const orders = admin.db('shop').collection('orders')
  await orders.insertMany(
    Array.from({ length: 5000 }, (_, i) => ({
      i,
      status: ['new', 'paid', 'shipped', 'cancelled'][i % 4],
      total: i % 500
    }))
  )
  const { storage } = makeStorage()
  connId = storage.save({ uri: server.getUri() }).id
  await manager.connect(storage.resolve(connId))
})

afterAll(async () => {
  await registry.cancelAll()
  await manager.disconnectAll()
  await admin?.close()
  await server?.stop()
})

describe('Done when: the index list matches db.coll.getIndexes() for every index type', () => {
  it('same indexes, same keys, same options', async () => {
    const ours = await indexes.list(connId, NS)
    const theirs = await admin.db('shop').collection('places').indexes()
    expect(ours.map((i) => i.name)).toEqual(theirs.map((i) => i.name))
    for (const t of theirs) {
      const o = ours.find((i) => i.name === t.name)!
      expect(o.fields.map((f) => f.field)).toEqual(Object.keys(t.key))
      expect(o.fields.map((f) => f.value)).toEqual(Object.values(t.key).map(String))
      expect(o.ttlSeconds).toBe(t.expireAfterSeconds ?? null)
      expect(o.kinds.includes('unique')).toBe(!!t.unique)
      expect(o.kinds.includes('sparse')).toBe(!!t.sparse)
      expect(o.kinds.includes('hidden')).toBe(!!t.hidden)
      expect(o.kinds.includes('partial')).toBe(!!t.partialFilterExpression)
    }
  })

  it('classifies each index type', async () => {
    const ours = await indexes.list(connId, NS)
    const theirs = await admin.db('shop').collection('places').indexes()
    for (const ix of FIXTURE) {
      const name = theirs.find(
        (t) => JSON.stringify(t.key) === JSON.stringify(ix.key) || t.name === ix.options?.name
      )!.name
      expect(ours.find((i) => i.name === name)!.kinds, name).toEqual(ix.kinds)
    }
    const id = ours.find((i) => i.name === '_id_')!
    expect(id.kinds).toEqual(['single'])
    expect(id.multikey).toBe(false)
  })

  it('shows details: weights, partial filter, collation, wildcard projection, size and usage', async () => {
    const ours = await indexes.list(connId, NS)
    const by = (n: string) => ours.find((i) => i.name === n)!
    expect(by('text_idx').weightsText).toMatch(/name: 5/)
    expect(by('score_1').partialFilterText).toMatch(/\$gt: 10/)
    expect(by('city_1').collationText).toMatch(/locale: "fr"/)
    expect(by('wildcard_all').wildcardProjectionText).toMatch(/secret: 0/)
    expect(by('name_1').size).toBeGreaterThan(0)
    expect(by('name_1').usage!.ops).toBeGreaterThanOrEqual(1)
    expect(by('status_1_createdAt_-1').multikey).toBe(false)
  })
})

describe('create, hide, drop', () => {
  it('creates with options from the form, hides/unhides and drops', async () => {
    const name = await indexes.create(connId, NS, {
      ...emptyCreateIndexForm,
      keys: '{ city: 1, score: -1 }',
      name: 'by_city',
      partialFilter: '{ score: { $gte: 5 } }'
    })
    expect(name).toBe('by_city')
    const spec = (await admin.db('shop').collection('places').indexes()).find((i) => i.name === 'by_city')!
    expect(spec.key).toEqual({ city: 1, score: -1 })
    expect(spec.partialFilterExpression).toEqual({ score: { $gte: 5 } })

    await indexes.setHidden(connId, NS, 'by_city', true)
    expect((await indexes.list(connId, NS)).find((i) => i.name === 'by_city')!.kinds).toContain('hidden')
    await indexes.setHidden(connId, NS, 'by_city', false)
    await indexes.drop(connId, NS, 'by_city')
    expect((await indexes.list(connId, NS)).some((i) => i.name === 'by_city')).toBe(false)
  })

  it('rejects bad forms with readable messages', async () => {
    await expect(indexes.create(connId, NS, { ...emptyCreateIndexForm, keys: '{}' })).rejects.toThrow(
      /at least one field/
    )
    await expect(indexes.create(connId, NS, { ...emptyCreateIndexForm, keys: '{ a: 2 }' })).rejects.toThrow(
      /must be 1, -1/
    )
    await expect(
      indexes.create(connId, NS, { ...emptyCreateIndexForm, keys: '{ a: 1 }', ttlSeconds: 'soon' })
    ).rejects.toThrow(/TTL/)
    await expect(indexes.drop(connId, NS, '_id_')).rejects.toThrow(/_id/)
  })

  it('reports no builds when none are running', async () => {
    expect(await indexes.builds(connId, NS)).toEqual([])
  })
})

describe('Done when: explain shows COLLSCAN and suggests an index; after creating it, IXSCAN', () => {
  const source = {
    kind: 'find' as const,
    query: { ...emptyQueryText, filter: "{ status: 'paid', total: { $gt: 100 } }", sort: '{ total: -1 }' }
  }

  it('find: collection scan → suggestion → index scan', async () => {
    const before = await explains.explain({ connectionId: connId, ns: 'shop.orders', source })
    expect(before.summary.collscan).toBe(true)
    expect(before.summary.docsExamined).toBe(5000)
    expect(before.hints.map((h) => h.kind)).toEqual(['collscan', 'sort'])
    expect(before.suggestion).toMatchObject({ keyText: '{ status: 1, total: -1 }', exists: false })

    await indexes.create(connId, 'shop.orders', { ...emptyCreateIndexForm, keys: before.suggestion!.keyText })
    const after = await explains.explain({ connectionId: connId, ns: 'shop.orders', source })
    expect(after.summary.collscan).toBe(false)
    expect(after.summary.indexes).toEqual(['status_1_total_-1'])
    expect(after.summary.inMemorySort).toBe(false)
    expect(after.hints).toEqual([])
    expect(JSON.stringify(after.tree)).toMatch(/IXSCAN/)
    expect(after.summary.docsExamined).toBe(after.summary.nReturned)
  })

  it('aggregate: explains the pipeline, without a final $out (never written)', async () => {
    const r = await explains.explain({
      connectionId: connId,
      ns: 'shop.orders',
      source: {
        kind: 'aggregate',
        stages: [
          { operator: '$match', body: '{ total: { $lt: 3 } }' },
          { operator: '$group', body: "{ _id: '$status', n: { $sum: 1 } }" },
          { operator: '$out', body: "'explain_leak'" }
        ],
        options: emptyPipelineOptions
      }
    })
    expect(r.notes.join(' ')).toMatch(/without the final \$out/)
    expect(r.summary.collscan).toBe(true)
    expect(r.suggestion?.keyText).toBe('{ total: 1 }')
    expect(await admin.db('shop').listCollections({ name: 'explain_leak' }).toArray()).toHaveLength(0)
  })

  it('reports query errors readably', async () => {
    await expect(
      explains.explain({
        connectionId: connId,
        ns: 'shop.orders',
        source: { kind: 'find', query: { ...emptyQueryText, filter: '{ a: ' } }
      })
    ).rejects.toThrow(/filter/)
  })
})

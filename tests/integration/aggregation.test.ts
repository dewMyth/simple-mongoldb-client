import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, type Document } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { BSON, Decimal128 } from 'bson'
import { ConnectionManager } from '../../src/main/services/connection-manager'
import { CursorRegistry } from '../../src/main/services/cursor-registry'
import { AggregationService, buildPipeline, RUN_LIMIT } from '../../src/main/services/aggregation-service'
import { emptyPipelineOptions, type StageInput, type StagePreview } from '../../src/shared/pipeline'
import { makeStorage } from './helpers'
import { stageFixtures } from '../fixtures/pipelines'

let server: MongoMemoryServer
let admin: MongoClient
let connId: string
const manager = new ConnectionManager()
const registry = new CursorRegistry()
const agg = new AggregationService(manager, registry)

const target = () => ({ connectionId: connId, ns: 'shop.orders', tabId: 'tab-agg' })
const sixStages: StageInput[] = stageFixtures[0]!.stages.map(({ operator, body }) => ({ operator, body }))
const canon = (docs: Document[]) => docs.map((d) => JSON.stringify(BSON.EJSON.serialize(d))).sort()
const decode = (p: StagePreview) => {
  if (p.status !== 'ok') throw new Error(JSON.stringify(p))
  return p.docs.map((b) => BSON.deserialize(b, { promoteValues: false }))
}

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  const shop = admin.db('shop')
  await shop
    .collection('products')
    .insertMany(['A', 'B', 'C', 'D'].map((sku, i) => ({ sku, name: `Product ${sku}`, price: i + 1 })))
  await shop.collection('orders').insertMany(
    Array.from({ length: 120 }, (_, i) => ({
      i,
      status: ['paid', 'shipped', 'new'][i % 3],
      total: Decimal128.fromString(`${5 + (i % 40)}.00`),
      items: [
        { sku: ['A', 'B', 'C', 'D'][i % 4], qty: 1 + (i % 3), price: 2 },
        { sku: ['A', 'B', 'C', 'D'][(i + 1) % 4], qty: 1, price: 3 }
      ]
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

describe('Done when: a 6-stage pipeline previews correctly at each stage', () => {
  it('each stage shows the output of the pipeline up to it', async () => {
    const previews = await agg.preview({
      ...target(),
      stages: sixStages,
      sampleSize: 1000,
      options: emptyPipelineOptions
    })
    expect(previews).toHaveLength(6)
    const built = buildPipeline(sixStages)
    if (!built.ok) throw new Error('fixture')
    for (let i = 0; i < 6; i++) {
      const expected = await admin
        .db('shop')
        .collection('orders')
        .aggregate(built.pipeline.slice(0, i + 1))
        .toArray()
      const actual = decode(previews[i]!)
      expect(actual.length, `stage ${i + 1}`).toBe(expected.length)
      expect(canon(actual), `stage ${i + 1}`).toEqual(canon(expected))
    }
    // Final stage ($sort revenue desc) keeps its order.
    const final = decode(previews[5]!)
    const revenues = final.map((d) => Number(String(d.revenue)))
    expect([...revenues].sort((a, b) => b - a)).toEqual(revenues)
    expect(final[0]).toHaveProperty('name')
  })

  it('limits each preview to the sample size and keeps BSON types', async () => {
    const previews = await agg.preview({
      ...target(),
      stages: sixStages.slice(0, 2),
      sampleSize: 7,
      options: emptyPipelineOptions
    })
    const docs = decode(previews[0]!)
    expect(docs).toHaveLength(7)
    expect(docs[0]!.total._bsontype).toBe('Decimal128')
    expect(decode(previews[1]!)).toHaveLength(7)
  })

  it('reports a syntax error in its own stage and blocks the stages after it', async () => {
    const stages = [
      { operator: '$match', body: '{}' },
      { operator: '$project', body: '{ a: ' },
      { operator: '$limit', body: '1' }
    ]
    const p = await agg.preview({ ...target(), stages, sampleSize: 5, options: emptyPipelineOptions })
    expect(p[0]!.status).toBe('ok')
    expect(p[1]).toMatchObject({ status: 'error', own: true })
    expect(p[2]).toEqual({ status: 'skipped', reason: 'blocked' })
  })

  it('reports server errors on the stage that fails', async () => {
    const p = await agg.preview({
      ...target(),
      stages: [{ operator: '$group', body: '{ total: { $sum: 1 } }' }],
      sampleSize: 5,
      options: emptyPipelineOptions
    })
    expect(p[0]).toMatchObject({ status: 'error', own: false })
    expect((p[0] as { message: string }).message).toMatch(/_id/)
  })
})

describe('Done when: $out never runs during preview', () => {
  const exists = async (name: string) =>
    (await admin.db('shop').listCollections({ name }, { nameOnly: true }).toArray()).length > 0

  it('skips $out and $merge stages (and anything after them)', async () => {
    const p = await agg.preview({
      ...target(),
      stages: [
        { operator: '$match', body: '{}' },
        { operator: '$out', body: "'leak_out'" },
        { operator: '$merge', body: "{ into: 'leak_merge' }" }
      ],
      sampleSize: 5,
      options: emptyPipelineOptions
    })
    expect(p.map((x) => x.status)).toEqual(['ok', 'skipped', 'skipped'])
    expect(p[1]).toEqual({ status: 'skipped', reason: 'write' })
    expect(await exists('leak_out')).toBe(false)
    expect(await exists('leak_merge')).toBe(false)
  })

  it('also when the write is nested (inside $facet or a $lookup pipeline)', async () => {
    const p = await agg.preview({
      ...target(),
      stages: [
        { operator: '$facet', body: "{ a: [{ $out: 'leak_facet' }] }" },
        { operator: '$lookup', body: "{ from: 'products', pipeline: [{ $merge: 'leak_lookup' }], as: 'x' }" }
      ],
      sampleSize: 5,
      options: emptyPipelineOptions
    })
    expect(p.map((x) => x.status)).toEqual(['skipped', 'skipped'])
    expect(await exists('leak_facet')).toBe(false)
    expect(await exists('leak_lookup')).toBe(false)
  })

  it('"Run full pipeline" does run $out, writing the results', async () => {
    const r = await agg.run({
      ...target(),
      stages: [
        { operator: '$match', body: "{ status: 'new' }" },
        { operator: '$out', body: "'orders_new'" }
      ],
      options: emptyPipelineOptions
    })
    expect(r).toMatchObject({ kind: 'written', target: 'shop.orders_new' })
    expect(await admin.db('shop').collection('orders_new').countDocuments()).toBe(40)
  })
})

describe('full runs, views, options', () => {
  it('returns at most RUN_LIMIT documents and says when there are more', async () => {
    const r = await agg.run({
      ...target(),
      stages: [{ operator: '$match', body: '{}' }],
      options: emptyPipelineOptions
    })
    expect(r.kind === 'docs' && r.docs.length).toBe(RUN_LIMIT)
    expect(r.kind === 'docs' && r.more).toBe(true)
    const all = await agg.run({ ...target(), stages: sixStages, options: emptyPipelineOptions })
    expect(all.kind === 'docs' && all.more).toBe(false)
  })

  it('applies collation and rejects bad options', async () => {
    const r = await agg.run({
      ...target(),
      stages: [
        { operator: '$match', body: "{ status: 'PAID' }" },
        { operator: '$count', body: "'n'" }
      ],
      options: { ...emptyPipelineOptions, collation: "{ locale: 'en', strength: 2 }", allowDiskUse: true }
    })
    expect(r.kind === 'docs' && BSON.deserialize(r.docs[0]!).n).toBe(40)
    await expect(
      agg.run({ ...target(), stages: [], options: { ...emptyPipelineOptions, maxTimeMS: 'soon' } })
    ).rejects.toThrow(/maxTimeMS/)
  })

  it('creates a view from the pipeline', async () => {
    const ns = await agg.createView({
      connectionId: connId,
      ns: 'shop.orders',
      name: 'paid_orders',
      stages: [{ operator: '$match', body: "{ status: 'paid' }" }]
    })
    expect(ns).toBe('shop.paid_orders')
    const info = await admin.db('shop').listCollections({ name: 'paid_orders' }).toArray()
    expect(info[0]).toMatchObject({ type: 'view', options: { viewOn: 'orders' } })
    expect(await admin.db('shop').collection('paid_orders').countDocuments()).toBe(40)
    await expect(
      agg.createView({
        connectionId: connId,
        ns: 'shop.orders',
        name: 'bad_view',
        stages: [{ operator: '$out', body: "'x'" }]
      })
    ).rejects.toThrow(/\$out/)
  })

  it('closing the tab cancels its previews (the "#preview" sub-owner)', async () => {
    const slow = agg.preview({
      ...target(),
      tabId: 'tab-slow#preview',
      // $where isn't allowed in aggregation; a JS $function that sleeps is slow enough.
      stages: [
        {
          operator: '$match',
          body: "{ $expr: { $function: { body: 'function() { sleep(50); return true }', args: [], lang: 'js' } } }"
        }
      ],
      sampleSize: 1000,
      options: emptyPipelineOptions
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(await registry.cancelForTab('tab-slow')).toBe(1)
    await expect(slow).rejects.toThrow(/cancelled/i)
  })
})

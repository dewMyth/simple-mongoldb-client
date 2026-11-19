import { afterAll, beforeAll, describe, expect, it } from 'vitest'
/** Test collections use numeric _ids. */
type NumDoc = { _id: number; [k: string]: unknown }
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Decimal128, Double, Int32, Long } from 'bson'
import { ConnectionManager } from '../../src/main/services/connection-manager'
import { CursorRegistry } from '../../src/main/services/cursor-registry'
import { SchemaService } from '../../src/main/services/schema-service'
import { setFilterField } from '../../src/main/services/query-parser'
import type { SchemaFieldInfo } from '../../src/shared/schema'
import { makeStorage } from './helpers'

let server: MongoMemoryServer
let admin: MongoClient
let connId: string
const manager = new ConnectionManager()
const registry = new CursorRegistry()
const schemas = new SchemaService(manager, registry)

/** 100 documents with known mixed types and presence. */
function fixture() {
  return Array.from({ length: 100 }, (_, i) => ({
    _id: i,
    // Int32 in 60, String in 25, missing in 15
    ...(i < 60 ? { age: new Int32(20 + (i % 40)) } : i < 85 ? { age: `${20 + i} years` } : {}),
    // numbers of four BSON types: must stay distinct
    amount:
      i % 4 === 0
        ? new Int32(i)
        : i % 4 === 1
          ? new Double(i + 0.5)
          : i % 4 === 2
            ? Long.fromNumber(i)
            : Decimal128.fromString(`${i}.25`),
    status: ['new', 'paid', 'shipped'][i % 3],
    active: i % 10 < 7,
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
    address: i % 2 ? { city: 'Paris', zip: new Int32(75000 + i) } : null,
    tags: i % 5 ? ['a', 'b'] : [],
    items: [{ sku: `S${i % 4}`, qty: new Int32(1) }]
  }))
}

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  await admin.db('shop').collection<NumDoc>('mixed').insertMany(fixture())
  const { storage } = makeStorage()
  connId = storage.save({ uri: server.getUri() }).id
  await manager.connect(storage.resolve(connId))
})

afterAll(async () => {
  await manager.disconnectAll()
  await admin?.close()
  await server?.stop()
})

const find = (fields: SchemaFieldInfo[], path: string): SchemaFieldInfo => {
  for (const f of fields) {
    if (f.path === path) return f
    const c = f.children.length ? find(f.children, path) : undefined
    if (c) return c
  }
  return undefined as unknown as SchemaFieldInfo
}

describe('Done when: the schema of the fixture collection reports mixed-type fields correctly', () => {
  it('types, shares and presence', async () => {
    const r = await schemas.analyze({ connectionId: connId, ns: 'shop.mixed', sampleSize: 1000, filter: '' })
    expect(r.sampled).toBe(100)

    const age = find(r.fields, 'age')
    expect(age.probability).toBeCloseTo(0.85)
    expect(age.types.map((t) => [t.type, t.count])).toEqual([
      ['int32', 60],
      ['string', 25]
    ])
    expect(age.types[0]!.probability).toBeCloseTo(60 / 85)

    const amount = find(r.fields, 'amount')
    expect(amount.probability).toBe(1)
    expect(Object.fromEntries(amount.types.map((t) => [t.type, t.count]))).toEqual({
      int32: 25,
      double: 25,
      int64: 25,
      decimal128: 25
    })

    const address = find(r.fields, 'address')
    expect(Object.fromEntries(address.types.map((t) => [t.type, t.count]))).toEqual({ object: 50, null: 50 })
    expect(find(r.fields, 'address.city').types.map((t) => t.type)).toEqual(['string'])
    expect(find(r.fields, 'address.zip').types.map((t) => t.type)).toEqual(['int32'])

    expect(find(r.fields, 'tags').types[0]).toMatchObject({ type: 'array' })
    expect(find(r.fields, 'items.sku').types.map((t) => t.type)).toEqual(['string'])
  })

  it('charts: top values for strings and booleans, histograms for numbers and dates', async () => {
    const r = await schemas.analyze({ connectionId: connId, ns: 'shop.mixed', sampleSize: 1000, filter: '' })
    const status = find(r.fields, 'status').types[0]!.chart!
    expect(status).toMatchObject({ kind: 'top', distinct: 3 })
    expect(status.kind === 'top' && status.values.map((v) => [v.valueText, v.count])).toEqual([
      ['"new"', 34],
      ['"paid"', 33],
      ['"shipped"', 33]
    ])
    const active = find(r.fields, 'active').types[0]!.chart!
    expect(active.kind === 'top' && active.values.map((v) => [v.valueText, v.count])).toEqual([
      ['true', 70],
      ['false', 30]
    ])
    const created = find(r.fields, 'createdAt').types[0]!.chart!
    expect(created.kind).toBe('histogram')
    if (created.kind === 'histogram') {
      expect(created.bins.reduce((n, b) => n + b.count, 0)).toBe(100)
      expect(created.bins[0]!.loText).toBe('ISODate("2026-01-01T00:00:00.000Z")')
    }
    const age = find(r.fields, 'age').types[0]!.chart!
    expect(age.kind).toBe('histogram') // 40 distinct ints
  })

  it('analyses only the documents matching a filter, and samples', async () => {
    const r = await schemas.analyze({
      connectionId: connId,
      ns: 'shop.mixed',
      sampleSize: 1000,
      filter: "{ status: 'paid' }"
    })
    expect(r.sampled).toBe(33)
    const small = await schemas.analyze({
      connectionId: connId,
      ns: 'shop.mixed',
      sampleSize: 10,
      filter: ''
    })
    expect(small.sampled).toBe(10)
    await expect(
      schemas.analyze({ connectionId: connId, ns: 'shop.mixed', sampleSize: 10, filter: '{ a: ' })
    ).rejects.toThrow(/Filter/)
  })
})

describe('setFilterField (clicking chart values)', () => {
  it('adds, replaces and toggles off a field, keeping the rest', () => {
    expect(setFilterField('', 'status', '"paid"')).toBe('{ status: "paid" }')
    expect(setFilterField('{ a: 1 }', 'address.city', '"Paris"')).toBe('{ a: 1, "address.city": "Paris" }')
    expect(setFilterField('{ status: "paid" }', 'status', '"new"')).toBe('{ status: "new" }')
    expect(setFilterField('{ status: "paid", a: 1 }', 'status', '"paid"')).toBe('{ a: 1 }')
    expect(setFilterField('{ status: "paid" }', 'status', '"paid"')).toBe('')
    // Long results are indented over several lines.
    const range = setFilterField(
      '{ a: 1 }',
      'when',
      '{ $gte: ISODate("2026-01-01T00:00:00Z"), $lt: ISODate("2026-01-02T00:00:00Z") }'
    )
    expect(range!.replace(/\s+/g, '')).toBe(
      '{a:1,when:{$gte:ISODate("2026-01-01T00:00:00.000Z"),$lt:ISODate("2026-01-02T00:00:00.000Z")}}'
    )
    expect(setFilterField('{ a: ', 'x', '1')).toBeNull()
  })
})

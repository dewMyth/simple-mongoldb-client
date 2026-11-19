import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/** Test collections use numeric _ids. */
type NumDoc = { _id: number; [k: string]: unknown }
import { MongoClient, type Document } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { BSON, Decimal128, Double, Int32, Long, ObjectId } from 'bson'
import { ConnectionManager } from '../../src/main/services/connection-manager'
import { CursorRegistry } from '../../src/main/services/cursor-registry'
import { ImportExportService } from '../../src/main/services/import-export/import-export-service'
import type { ExportStart, ImportStart, JobProgress } from '../../src/shared/import-export'
import { emptyQueryText } from '../../src/shared/query'
import { allTypesDoc } from '../fixtures/all-types'
import { makeStorage } from './helpers'

let server: MongoMemoryServer
let admin: MongoClient
let connId: string
const manager = new ConnectionManager()
const registry = new CursorRegistry()
const events: JobProgress[] = []
const svc = new ImportExportService(manager, registry, (p) => events.push(p))
const dir = mkdtempSync(join(tmpdir(), 'ms-io-'))
const file = (name: string) => join(dir, name)

/** Raw BSON of every document in a collection, by _id order (byte-exact comparison). */
async function rawDocs(coll: string): Promise<string[]> {
  const docs = await admin
    .db('shop')
    .collection(coll)
    .find({}, { raw: true, sort: { _id: 1 } })
    .toArray()
  return docs.map((d) => Buffer.from(d as unknown as Uint8Array).toString('hex'))
}

async function exportTo(path: string, input: Omit<ExportStart, 'connectionId' | 'token'>) {
  const { token } = await svc.registerFile(path, 'write')
  return svc.startExport({ connectionId: connId, token, ...input }).done
}

async function importFrom(path: string, input: Omit<ImportStart, 'connectionId' | 'token'>) {
  const { token } = await svc.registerFile(path, 'read')
  return svc.startImport({ connectionId: connId, token, ...input }, (fn) => fn()).done
}

/** Varied documents: every BSON type, nested and in arrays, with values that trip JSON up. */
function variedDocs(n: number): Document[] {
  return Array.from({ length: n }, (_, i) => ({
    _id: i,
    i32: new Int32(i),
    dbl: new Double(i + 0.5),
    dblWhole: new Double(i),
    long: Long.fromString(`${9007199254740993n + BigInt(i)}`),
    dec: Decimal128.fromString(`${i}.10`),
    when: new Date(Date.UTC(1960 + (i % 80), i % 12, 1 + (i % 28))),
    oid: new ObjectId(),
    text: `line ${i}\nwith "quotes", commas and ünïcödé`,
    nested: { arr: [new Int32(1), Long.fromNumber(2), null, { deep: [new Double(3)] }] }
  }))
}

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  const shop = admin.db('shop')
  await shop.collection('types').insertMany([allTypesDoc(), ...variedDocs(200)])
  const { storage } = makeStorage()
  connId = storage.save({ uri: server.getUri() }).id
  await manager.connect(storage.resolve(connId))
})

afterAll(async () => {
  await svc.cancelAll()
  await manager.disconnectAll()
  await admin?.close()
  await server?.stop()
})

describe('Done when: export then import of the all-types collection via EJSON is lossless (BSON compare)', () => {
  for (const format of ['json', 'jsonl'] as const) {
    it(`canonical EJSON, ${format}`, async () => {
      const path = file(`types.${format}`)
      const exported = await exportTo(path, {
        ns: 'shop.types',
        source: { kind: 'collection' },
        format,
        ejson: 'canonical'
      })
      expect(exported).toMatchObject({ status: 'done', processed: 201, total: 201 })

      const target = `types_from_${format}`
      const imported = await importFrom(path, {
        ns: `shop.${target}`,
        format: 'json',
        ignoreEmpty: true,
        stopOnError: true
      })
      expect(imported).toMatchObject({ status: 'done', inserted: 201, failed: 0 })
      expect(await rawDocs(target)).toEqual(await rawDocs('types'))
    })
  }

  it('relaxed EJSON is readable JSON (numbers as plain numbers)', async () => {
    const path = file('relaxed.json')
    await exportTo(path, {
      ns: 'shop.types',
      source: { kind: 'query', query: { ...emptyQueryText, filter: '{ _id: 3 }' } },
      format: 'json',
      ejson: 'relaxed'
    })
    const [doc] = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[]
    expect(doc!.i32).toBe(3)
    expect(doc!.dbl).toBe(3.5)
  })
})

describe('export', () => {
  it('exports the current query (filter, sort, projection, limit)', async () => {
    const path = file('query.jsonl')
    const r = await exportTo(path, {
      ns: 'shop.types',
      source: {
        kind: 'query',
        query: {
          ...emptyQueryText,
          filter: '{ _id: { $lt: 10 } }',
          sort: '{ _id: -1 }',
          project: '{ i32: 1 }',
          limit: '3'
        }
      },
      format: 'jsonl',
      ejson: 'canonical'
    })
    expect(r).toMatchObject({ status: 'done', processed: 3, total: 3 })
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Document)
    expect(lines.map((d) => d._id)).toEqual([{ $numberInt: '9' }, { $numberInt: '8' }, { $numberInt: '7' }])
    expect(Object.keys(lines[0]!)).toEqual(['_id', 'i32'])
  })

  it('CSV with chosen fields, then CSV import with column types', async () => {
    const path = file('types.csv')
    const r = await exportTo(path, {
      ns: 'shop.types',
      source: {
        kind: 'query',
        query: { ...emptyQueryText, filter: '{ _id: { $type: "int" } }', sort: '{ _id: 1 }' }
      },
      format: 'csv',
      ejson: 'relaxed',
      fields: ['_id', 'i32', 'long', 'dec', 'when', 'text', 'nested.arr']
    })
    expect(r.processed).toBe(200)
    const csv = readFileSync(path, 'utf8')
    expect(csv.split('\n')[0]).toBe('_id,i32,long,dec,when,text,nested.arr')

    const imported = await importFrom(path, {
      ns: 'shop.from_csv',
      format: 'csv',
      columns: [
        { name: '_id', type: 'int32' },
        { name: 'i32', type: 'int32' },
        { name: 'long', type: 'int64' },
        { name: 'dec', type: 'decimal128' },
        { name: 'when', type: 'date' },
        { name: 'text', type: 'string' },
        { name: 'nested.arr', type: 'exclude' }
      ],
      ignoreEmpty: true,
      stopOnError: true
    })
    expect(imported).toMatchObject({ status: 'done', inserted: 200, failed: 0 })
    const back = await admin
      .db('shop')
      .collection<NumDoc>('from_csv')
      .findOne({ _id: 7 }, { promoteValues: false })
    const orig = await admin
      .db('shop')
      .collection<NumDoc>('types')
      .findOne({ _id: 7 }, { promoteValues: false })
    for (const k of ['i32', 'long', 'dec', 'when', 'text'])
      expect(BSON.serialize({ v: back![k] }), k).toEqual(BSON.serialize({ v: orig![k] }))
    expect(back!.nested).toBeUndefined()
  })

  it('exports documents bigger than the 1 MB output buffer', async () => {
    const big = 'é'.repeat(1_500_000) // 3 MB of UTF-8
    await admin
      .db('shop')
      .collection<NumDoc>('huge')
      .insertMany([
        { _id: 1, s: 'a' },
        { _id: 2, s: big },
        { _id: 3, s: 'c' }
      ])
    const path = file('huge.jsonl')
    const r = await exportTo(path, {
      ns: 'shop.huge',
      source: { kind: 'collection' },
      format: 'jsonl',
      ejson: 'canonical'
    })
    expect(r.processed).toBe(3)
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { s: string })
    expect(lines.map((d) => d.s.length)).toEqual([1, 1_500_000, 1])
  })

  it('cancelling removes the partial file', async () => {
    const path = file('cancelled.json')
    const { token } = await svc.registerFile(path, 'write')
    const job = svc.startExport({
      connectionId: connId,
      token,
      ns: 'shop.types',
      source: { kind: 'collection' },
      format: 'json',
      ejson: 'canonical'
    })
    svc.cancel(job.progress.jobId)
    const r = await job.done
    expect(r.status).toBe('cancelled')
    expect(existsSync(path)).toBe(false)
  })

  it('refuses paths that did not come from a dialog token', () => {
    expect(() =>
      svc.startExport({
        connectionId: connId,
        token: 'forged',
        ns: 'shop.types',
        source: { kind: 'collection' },
        format: 'json',
        ejson: 'canonical'
      })
    ).toThrow(/Choose the file again/)
  })

  it('streams: exporting many documents keeps memory flat', async () => {
    const big = admin.db('shop').collection<NumDoc>('big')
    const pad = 'x'.repeat(200)
    for (let b = 0; b < 30; b++)
      await big.insertMany(
        Array.from({ length: 10_000 }, (_, i) => ({ _id: b * 10_000 + i, pad, n: i, when: new Date() }))
      )
    globalThis.gc?.()
    const base = process.memoryUsage().heapUsed
    let peak = 0
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed - base)), 20)
    const r = await exportTo(file('big.jsonl'), {
      ns: 'shop.big',
      source: { kind: 'collection' },
      format: 'jsonl',
      ejson: 'canonical'
    })
    clearInterval(timer)
    expect(r.processed).toBe(300_000)
    // 300k documents (~100 MB of EJSON) never sit in memory together.
    expect(peak).toBeLessThan(120 * 1024 * 1024)
  })
})

describe('import', () => {
  it('previews JSON and CSV files with detected column types', async () => {
    writeFileSync(file('p.json'), '[{"a":1},{"a":{"$numberLong":"5"}}]')
    const { token } = await svc.registerFile(file('p.json'), 'read')
    const p = await svc.preview(token)
    expect(p.format).toBe('json')
    expect(p.docs.map((d) => BSON.deserialize(d, { promoteValues: false }).a._bsontype)).toEqual([
      'Int32',
      'Long'
    ])

    writeFileSync(file('p.csv'), 'name,age,joined,active\nAda,36,2026-01-02,true\nBob,41,2025-12-01,false\n')
    const c = await svc.preview((await svc.registerFile(file('p.csv'), 'read')).token)
    expect(c.csv).toEqual({
      headers: ['name', 'age', 'joined', 'active'],
      rows: [
        ['Ada', '36', '2026-01-02', 'true'],
        ['Bob', '41', '2025-12-01', 'false']
      ],
      detected: ['string', 'int32', 'date', 'boolean']
    })
  })

  it('skip errors: imports the good documents and reports the bad ones', async () => {
    await admin.db('shop').collection<NumDoc>('dupes').insertOne({ _id: 2 })
    writeFileSync(file('errs.jsonl'), ['{"_id":1}', '{"_id":2}', 'not json', '[1,2]', '{"_id":3}'].join('\n'))
    const r = await importFrom(file('errs.jsonl'), {
      ns: 'shop.dupes',
      format: 'json',
      ignoreEmpty: true,
      stopOnError: false
    })
    expect(r).toMatchObject({ status: 'done', inserted: 2, failed: 3 })
    expect(r.errors.join('\n')).toMatch(/duplicate key/)
    expect(r.errors.join('\n')).toMatch(/must be a document/)
  })

  it('stop on error: stops at the first failure', async () => {
    writeFileSync(file('stop.jsonl'), ['{"_id":10}', 'not json', '{"_id":11}'].join('\n'))
    const r = await importFrom(file('stop.jsonl'), {
      ns: 'shop.stop',
      format: 'json',
      ignoreEmpty: true,
      stopOnError: true
    })
    expect(r.status).toBe('error')
    expect(await admin.db('shop').collection<NumDoc>('stop').countDocuments({ _id: 11 })).toBe(0)
  })

  it('reports progress events while running', () => {
    expect(events.some((e) => e.kind === 'import' && e.status === 'running')).toBe(true)
    expect(events.some((e) => e.kind === 'export' && e.status === 'done')).toBe(true)
  })
})

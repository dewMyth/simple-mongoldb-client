import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BSON, Decimal128, MongoClient, ObjectId, type Document } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { ConnectionManager } from '../../src/main/services/connection-manager'
import { DocumentService } from '../../src/main/services/document-service'
import { fromBsonBytes, ownBytes, toBsonBytes, type BsonBytes } from '../../src/shared/bson-wire'
import { setAt } from '../../src/shared/doc-edit'
import { emptyQueryText } from '../../src/shared/query'
import { allTypesDoc, ALL_TYPES_ID } from '../fixtures/all-types'
import { makeStorage } from './helpers'

let server: MongoMemoryServer
let admin: MongoClient
let connId: string
const manager = new ConnectionManager()
const docs = new DocumentService(manager)
const coll = () => admin.db('shop').collection('edit')
const ns = 'shop.edit'

/** The document exactly as the app would have loaded it (raw bytes from the server). */
async function load(id: unknown): Promise<BsonBytes> {
  const raw = (await coll().findOne({ _id: id as never }, { raw: true })) as unknown as Uint8Array
  return ownBytes(raw)
}
const edit = (bytes: BsonBytes, fn: (d: Document) => Document) => toBsonBytes(fn(fromBsonBytes(bytes)))

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  const { storage } = makeStorage()
  connId = storage.save({ uri: server.getUri() }).id
  await manager.connect(storage.resolve(connId))
})

afterEach(async () => {
  await coll().deleteMany({})
})

afterAll(async () => {
  await manager.disconnectAll()
  await admin?.close()
  await server?.stop()
})

describe('update (single document)', () => {
  it('editing one field leaves every other field byte-identical', async () => {
    await coll().insertOne(allTypesDoc())
    const original = await load(ALL_TYPES_ID)
    const res = await docs.update({
      connectionId: connId,
      ns,
      original,
      edited: edit(original, (d) => setAt(d, ['string'], 'changed'))
    })
    expect(res.status).toBe('updated')

    const after = BSON.deserialize(await load(ALL_TYPES_ID), { promoteValues: false, bsonRegExp: true })
    const before = BSON.deserialize(original, { promoteValues: false, bsonRegExp: true })
    expect(after['string']).toBe('changed')
    delete after['string']
    delete before['string']
    expect(Buffer.from(BSON.serialize(after)).equals(Buffer.from(BSON.serialize(before)))).toBe(true)
  })

  it('keeps Decimal128 as Decimal128', async () => {
    await coll().insertOne(allTypesDoc())
    const original = await load(ALL_TYPES_ID)
    await docs.update({
      connectionId: connId,
      ns,
      original,
      edited: edit(original, (d) => setAt(d, ['decimal128Small'], Decimal128.fromString('12.75')))
    })
    const v = (await coll().findOne({ _id: ALL_TYPES_ID }, { promoteValues: false }))!['decimal128Small']
    expect(v._bsontype).toBe('Decimal128')
    expect(v.toString()).toBe('12.75')
  })

  it('detects a concurrent change to an edited field', async () => {
    await coll().insertOne({ _id: 1 as never, a: 'x', b: 1 })
    const original = await load(1)
    await coll().updateOne({ _id: 1 as never }, { $set: { a: 'someone else' } })
    const res = await docs.update({
      connectionId: connId,
      ns,
      original,
      edited: edit(original, (d) => setAt(d, ['a'], 'mine'))
    })
    expect(res.status).toBe('conflict')
    expect(res.status === 'conflict' && fromBsonBytes(res.current!)['a']).toBe('someone else')
    expect((await coll().findOne({ _id: 1 as never }))!['a']).toBe('someone else')
  })

  it("keeps someone else's change to a different field", async () => {
    await coll().insertOne({ _id: 1 as never, a: 'x', b: 1 })
    const original = await load(1)
    await coll().updateOne({ _id: 1 as never }, { $set: { b: 2 } })
    const res = await docs.update({
      connectionId: connId,
      ns,
      original,
      edited: edit(original, (d) => setAt(d, ['a'], 'mine'))
    })
    expect(res.status).toBe('updated')
    expect(await coll().findOne({ _id: 1 as never })).toEqual({ _id: 1, a: 'mine', b: 2 })
  })

  it('force-overwrites after a conflict, and handles a deleted document', async () => {
    await coll().insertOne({ _id: 1 as never, a: 'x' })
    const original = await load(1)
    await coll().deleteOne({ _id: 1 as never })
    const edited = edit(original, (d) => setAt(d, ['a'], 'mine'))
    const res = await docs.update({ connectionId: connId, ns, original, edited })
    expect(res).toEqual({ status: 'conflict', current: null })
    expect((await docs.update({ connectionId: connId, ns, original, edited, force: true })).status).toBe(
      'updated'
    )
    expect(await coll().findOne({ _id: 1 as never })).toEqual({ _id: 1, a: 'mine' })
  })

  it('uses a conflict-safe full replacement for keys that $set cannot address', async () => {
    await coll().insertOne({ _id: 1 as never, 'dotted.key': 'x', $dollar: 1 } as Document)
    const original = await load(1)
    const res = await docs.update({
      connectionId: connId,
      ns,
      original,
      edited: edit(original, (d) => setAt(d, ['dotted.key'], 'y'))
    })
    expect(res.status).toBe('updated')
    expect((await coll().findOne({ _id: 1 as never }))!['dotted.key']).toBe('y')

    // Same edit again from the stale original: the document changed, so it's a conflict.
    const stale = await docs.update({
      connectionId: connId,
      ns,
      original,
      edited: edit(original, (d) => setAt(d, ['dotted.key'], 'z'))
    })
    expect(stale.status).toBe('conflict')
  })

  it('does nothing when nothing changed, and refuses documents without _id or _id changes', async () => {
    await coll().insertOne({ _id: 1 as never, a: 'x' })
    const original = await load(1)
    expect((await docs.update({ connectionId: connId, ns, original, edited: original })).status).toBe(
      'unchanged'
    )
    await expect(
      docs.update({ connectionId: connId, ns, original, edited: edit(original, (d) => setAt(d, ['_id'], 2)) })
    ).rejects.toThrow(/_id can't be changed/)
    await expect(
      docs.update({
        connectionId: connId,
        ns,
        original: toBsonBytes({ a: 1 }),
        edited: toBsonBytes({ a: 2 })
      })
    ).rejects.toThrow(/no _id/)
  })
})

describe('parse, insert, delete', () => {
  it('parses one document or an array, in shell syntax', () => {
    const one = docs.parseDocuments('{ n: NumberLong("5"), d: ISODate("2026-01-01") }')
    expect(one.ok && one.docs.length).toBe(1)
    const many = docs.parseDocuments('[{ a: 1 }, { a: 2 }]')
    expect(many.ok && many.docs.length).toBe(2)
    const bad = docs.parseDocuments('{ a: ')
    expect(bad.ok).toBe(false)
    expect(docs.parseDocuments('[1, 2]').ok).toBe(false)
  })

  it('inserts documents with their types', async () => {
    const parsed = docs.parseDocuments('[{ n: NumberLong("9007199254740993") }, { _id: 7, n: NumberInt(1) }]')
    if (!parsed.ok) throw new Error(parsed.error.message)
    const res = await docs.insert({ connectionId: connId, ns, docs: parsed.docs })
    expect(res.insertedCount).toBe(2)
    expect(res.errors).toEqual([])
    const n = (await coll().findOne({ _id: 7 as never }, { promoteValues: false }))!['n']
    expect(n._bsontype).toBe('Int32')
    // Duplicate key is reported per document, others still go in.
    const again = await docs.insert({
      connectionId: connId,
      ns,
      docs: [toBsonBytes({ _id: 7 }), toBsonBytes({ _id: 8 })]
    })
    expect(again.insertedCount).toBe(1)
    expect(again.errors[0]).toMatchObject({ index: 0, message: expect.stringMatching(/Duplicate key/) })
  })

  it('deletes one document by _id, or all matching a filter', async () => {
    await coll().insertMany([
      { _id: 1, s: 'a' },
      { _id: 2, s: 'a' },
      { _id: 3, s: 'b' }
    ] as never)
    expect(await docs.deleteOne({ connectionId: connId, ns, original: await load(1) })).toEqual({
      deleted: true
    })
    expect(
      await docs.deleteMany({ connectionId: connId, ns, query: { ...emptyQueryText, filter: '{ s: "a" }' } })
    ).toEqual({ deletedCount: 1 })
    expect(await coll().countDocuments()).toBe(1)
  })
})

describe('bulk update', () => {
  const q = (filter: string) => ({ ...emptyQueryText, filter })

  it('previews operator updates without writing, then applies them', async () => {
    await coll().insertMany(
      Array.from({ length: 8 }, (_, i) => ({ _id: i, n: i, tag: 'x', list: [1] })) as never
    )
    const update = '{ $inc: { n: 10 }, $set: { tag: "y", note: "$notAFieldPath" }, $unset: { list: "" } }'
    const preview = await docs.previewUpdate({
      connectionId: connId,
      ns,
      query: q('{ n: { $gte: 2 } }'),
      update
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.items).toHaveLength(5)
    const first = preview.items[0]!
    expect(BSON.deserialize(first.before)).toMatchObject({ n: 2, tag: 'x' })
    const after = BSON.deserialize(first.after)
    expect(after).toEqual({ _id: 2, n: 12, tag: 'y', note: '$notAFieldPath' })
    expect(await coll().countDocuments({ tag: 'y' })).toBe(0) // nothing written

    const res = await docs.updateMany({ connectionId: connId, ns, query: q('{ n: { $gte: 2 } }'), update })
    expect(res).toEqual({ matchedCount: 6, modifiedCount: 6 })
    expect(await coll().findOne({ _id: 7 as never })).toEqual({
      _id: 7,
      n: 17,
      tag: 'y',
      note: '$notAFieldPath'
    })
  })

  it('previews pipeline updates', async () => {
    await coll().insertMany([{ _id: 1, a: 2, b: 3 }] as never)
    const preview = await docs.previewUpdate({
      connectionId: connId,
      ns,
      query: q('{}'),
      update: '[{ $set: { sum: { $add: ["$a", "$b"] } } }]'
    })
    expect(preview.ok && BSON.deserialize(preview.items[0]!.after)['sum']).toBe(5)
  })

  it('explains when an operator cannot be previewed, and rejects replacement documents', async () => {
    await coll().insertOne({ _id: 1 as never, a: [1, 2] })
    const p = await docs.previewUpdate({
      connectionId: connId,
      ns,
      query: q('{}'),
      update: '{ $pull: { a: { $gt: 1 } } }'
    })
    expect(p.ok).toBe(false)
    expect(!p.ok && p.error).toMatch(/can't be previewed/)
    await expect(
      docs.updateMany({ connectionId: connId, ns, query: q('{}'), update: '{ a: 1 }' })
    ).rejects.toThrow(/update operators/)
  })

  it('previews array operators', async () => {
    await coll().insertOne({ _id: new ObjectId(), a: [1, 2, 2], b: [1] } as never)
    const p = await docs.previewUpdate({
      connectionId: connId,
      ns,
      query: q('{}'),
      update: '{ $push: { b: { $each: [2, 3] } }, $pull: { a: 2 }, $addToSet: { c: 5 } }'
    })
    expect(p.ok && BSON.deserialize(p.items[0]!.after)).toMatchObject({ a: [1], b: [1, 2, 3], c: [5] })
  })
})

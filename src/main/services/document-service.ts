/**
 * Document writes: conflict-safe single-document updates, insert, delete, and bulk update with a
 * write-free preview. Permission checks happen in the IPC layer (permissions.guard) before these.
 */
import { MongoBulkWriteError, type Collection, type Document } from 'mongodb'
import { fromBsonBytes, ownBytes, toBsonBytes, type BsonBytes } from '@shared/bson-wire'
import {
  conflictFilter,
  diffDocuments,
  diffNeedsReplacement,
  exactDocumentFilter,
  isEmptyDiff,
  sameValue,
  updateFromDiff
} from '@shared/doc-edit'
import type { InsertResult, ParseDocumentsResult, UpdatePreview, UpdateResult } from '@shared/documents'
import type { QueryText } from '@shared/query'
import type { ConnectionManager } from './connection-manager'
import { PRESERVE_TYPES } from './bson-options'
import { ReadableError, readableMessage } from './errors'
import { parseQuery, parseShellValue } from './query-parser'
import { splitNamespace } from './query-service'

const isPlainObject = (v: unknown): v is Document =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v as { _bsontype?: string })._bsontype

class NotPreviewable extends Error {}

/**
 * Full replacement as an update pipeline. replaceOne() rejects field names starting with "$";
 * $replaceWith + $literal accepts any document (MongoDB 5.0+).
 */
const replaceWith = (doc: Document): Document[] => [{ $replaceWith: { $literal: doc } }]

/** Converts an update-operator document into equivalent pipeline stages, for previewing only. */
export function operatorsToPipeline(update: Document): Document[] {
  const lit = (v: unknown) => ({ $literal: v })
  const ref = (f: string) => `$${f}`
  const stages: Document[] = []
  const checkPath = (op: string, f: string) => {
    if (f.split('.').some((s) => /^\d+$/.test(s) || s.startsWith('$')))
      throw new NotPreviewable(`${op} on "${f}" (array index or positional path) can't be previewed`)
  }
  for (const [op, spec] of Object.entries(update)) {
    const fields = Object.entries(spec as Document)
    for (const [f] of fields) checkPath(op, f)
    switch (op) {
      case '$set':
        stages.push({ $set: Object.fromEntries(fields.map(([f, v]) => [f, lit(v)])) })
        break
      case '$unset':
        stages.push({ $unset: fields.map(([f]) => f) })
        break
      case '$inc':
        stages.push({
          $set: Object.fromEntries(fields.map(([f, v]) => [f, { $add: [{ $ifNull: [ref(f), 0] }, lit(v)] }]))
        })
        break
      case '$mul':
        stages.push({
          $set: Object.fromEntries(
            fields.map(([f, v]) => [f, { $multiply: [{ $ifNull: [ref(f), 0] }, lit(v)] }])
          )
        })
        break
      case '$min':
      case '$max':
        stages.push({ $set: Object.fromEntries(fields.map(([f, v]) => [f, { [op]: [ref(f), lit(v)] }])) })
        break
      case '$rename':
        for (const [from, to] of fields) {
          checkPath(op, String(to))
          stages.push({ $set: { [String(to)]: ref(from) } }, { $unset: from })
        }
        break
      case '$currentDate':
        for (const [, v] of fields)
          if (isPlainObject(v) && v['$type'] === 'timestamp')
            throw new NotPreviewable('$currentDate with $type "timestamp" can\'t be previewed')
        stages.push({ $set: Object.fromEntries(fields.map(([f]) => [f, '$$NOW'])) })
        break
      case '$push':
        stages.push({
          $set: Object.fromEntries(
            fields.map(([f, v]) => {
              let items: unknown[] = [v]
              if (isPlainObject(v) && Object.keys(v).some((k) => k.startsWith('$'))) {
                if (Object.keys(v).some((k) => k !== '$each'))
                  throw new NotPreviewable("$push with $position, $slice or $sort can't be previewed")
                items = v['$each'] as unknown[]
              }
              return [f, { $concatArrays: [{ $ifNull: [ref(f), []] }, lit(items)] }]
            })
          )
        })
        break
      case '$addToSet':
        stages.push({
          $set: Object.fromEntries(
            fields.map(([f, v]) => {
              const items = isPlainObject(v) && '$each' in v ? (v['$each'] as unknown[]) : [v]
              return [
                f,
                {
                  $reduce: {
                    input: lit(items),
                    initialValue: { $ifNull: [ref(f), []] },
                    in: {
                      $cond: [
                        { $in: ['$$this', '$$value'] },
                        '$$value',
                        { $concatArrays: ['$$value', ['$$this']] }
                      ]
                    }
                  }
                }
              ]
            })
          )
        })
        break
      case '$pull':
      case '$pullAll':
        stages.push({
          $set: Object.fromEntries(
            fields.map(([f, v]) => {
              if (
                op === '$pull' &&
                (isPlainObject(v) || (v as { _bsontype?: string })?._bsontype === 'BSONRegExp')
              )
                throw new NotPreviewable("$pull with a condition or document match can't be previewed")
              const cond =
                op === '$pull' ? { $ne: ['$$this', lit(v)] } : { $not: [{ $in: ['$$this', lit(v)] }] }
              return [f, { $cond: [{ $isArray: ref(f) }, { $filter: { input: ref(f), cond } }, ref(f)] }]
            })
          )
        })
        break
      case '$setOnInsert':
        break // no effect on existing documents
      default:
        throw new NotPreviewable(`${op} can't be previewed`)
    }
  }
  return stages
}

type ParsedUpdate = { kind: 'operators'; update: Document } | { kind: 'pipeline'; update: Document[] }

function parseUpdate(text: string): ParsedUpdate {
  const res = parseShellValue(text)
  if (!res.ok) throw new Error(res.error.message)
  const v = res.value
  if (Array.isArray(v)) {
    if (
      !v.every((s) => isPlainObject(s) && Object.keys(s).length === 1 && Object.keys(s)[0]!.startsWith('$'))
    )
      throw new Error('A pipeline update is an array of stages, like [{ $set: { … } }]')
    return { kind: 'pipeline', update: v as Document[] }
  }
  if (isPlainObject(v) && Object.keys(v).length && Object.keys(v).every((k) => k.startsWith('$')))
    return { kind: 'operators', update: v }
  throw new Error(
    'Bulk updates need update operators like { $set: { … } } or a pipeline [ … ], not a replacement document'
  )
}

export class DocumentService {
  constructor(private readonly connections: ConnectionManager) {}

  private collection(connectionId: string, ns: string): Collection {
    const { db, coll } = splitNamespace(ns)
    return this.connections.client(connectionId).db(db).collection(coll)
  }

  private async fetch(c: Collection, id: unknown): Promise<BsonBytes | null> {
    const raw = await c.findOne({ _id: { $eq: id } } as Document, { raw: true })
    return raw ? ownBytes(raw as unknown as Uint8Array) : null
  }

  private filterOf(query: QueryText) {
    const parsed = parseQuery(query)
    if (!parsed.ok) throw new Error(parsed.errors.map((e) => `${e.field}: ${e.message}`).join('\n'))
    return parsed.query
  }

  /** One document or an array of documents, in shell syntax. */
  parseDocuments(text: string): ParseDocumentsResult {
    const res = parseShellValue(text)
    if (!res.ok) return { ok: false, error: res.error }
    const list = Array.isArray(res.value) ? res.value : [res.value]
    if (!list.length) return { ok: false, error: { message: 'No documents' } }
    if (!list.every(isPlainObject))
      return { ok: false, error: { message: 'Expected a document { … } or an array of documents' } }
    return { ok: true, docs: list.map((d) => toBsonBytes(d)) }
  }

  async update(input: {
    connectionId: string
    ns: string
    original: BsonBytes
    edited: BsonBytes
    force?: boolean
  }): Promise<UpdateResult> {
    const orig = fromBsonBytes(input.original)
    const next = fromBsonBytes(input.edited)
    if (!('_id' in orig)) throw new Error("This document has no _id, so it can't be edited safely.")
    if (!sameValue(orig['_id'], next['_id']))
      throw new Error("_id can't be changed. Clone the document instead.")
    const c = this.collection(input.connectionId, input.ns)
    try {
      if (input.force) {
        // "Overwrite": the user saw the conflict and chose their version (re-created if deleted).
        await c.updateOne({ _id: { $eq: orig['_id'] } } as Document, replaceWith(next), { upsert: true })
        return { status: 'updated', doc: await this.fetch(c, orig['_id']) }
      }
      const diff = diffDocuments(orig, next)
      if (isEmptyDiff(diff)) return { status: 'unchanged' }
      const res = diffNeedsReplacement(diff)
        ? await c.updateOne(exactDocumentFilter(orig), replaceWith(next))
        : await c.updateOne(conflictFilter(orig, diff), updateFromDiff(diff))
      if (res.matchedCount === 0) return { status: 'conflict', current: await this.fetch(c, orig['_id']) }
      return { status: 'updated', doc: await this.fetch(c, orig['_id']) }
    } catch (err) {
      throw new ReadableError(err)
    }
  }

  async insert(input: { connectionId: string; ns: string; docs: BsonBytes[] }): Promise<InsertResult> {
    const c = this.collection(input.connectionId, input.ns)
    try {
      const res = await c.insertMany(input.docs.map(fromBsonBytes), { ordered: false })
      return { insertedCount: res.insertedCount, errors: [] }
    } catch (err) {
      if (err instanceof MongoBulkWriteError) {
        const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors]
        return {
          insertedCount: err.result.insertedCount,
          errors: writeErrors.map((e) => ({ index: e.index, message: readableMessage(e) }))
        }
      }
      throw new ReadableError(err)
    }
  }

  async deleteOne(input: {
    connectionId: string
    ns: string
    original: BsonBytes
  }): Promise<{ deleted: boolean }> {
    const orig = fromBsonBytes(input.original)
    if (!('_id' in orig)) throw new Error("This document has no _id, so it can't be deleted individually.")
    try {
      const res = await this.collection(input.connectionId, input.ns).deleteOne({
        _id: { $eq: orig['_id'] }
      } as Document)
      return { deleted: res.deletedCount === 1 }
    } catch (err) {
      throw new ReadableError(err)
    }
  }

  async deleteMany(input: {
    connectionId: string
    ns: string
    query: QueryText
  }): Promise<{ deletedCount: number }> {
    const q = this.filterOf(input.query)
    try {
      const res = await this.collection(input.connectionId, input.ns).deleteMany(q.filter, {
        collation: q.collation as never
      })
      return { deletedCount: res.deletedCount }
    } catch (err) {
      throw new ReadableError(err)
    }
  }

  async updateMany(input: { connectionId: string; ns: string; query: QueryText; update: string }) {
    const q = this.filterOf(input.query)
    const parsed = parseUpdate(input.update)
    try {
      const res = await this.collection(input.connectionId, input.ns).updateMany(q.filter, parsed.update, {
        collation: q.collation as never
      })
      return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount }
    } catch (err) {
      throw new ReadableError(err)
    }
  }

  /** Before/after for the first `limit` matching documents. Never writes. */
  async previewUpdate(input: {
    connectionId: string
    ns: string
    query: QueryText
    update: string
    limit?: number
  }): Promise<UpdatePreview> {
    let stages: Document[]
    let q: ReturnType<DocumentService['filterOf']>
    try {
      q = this.filterOf(input.query)
      const parsed = parseUpdate(input.update)
      stages = parsed.kind === 'pipeline' ? parsed.update : operatorsToPipeline(parsed.update)
    } catch (err) {
      if (err instanceof NotPreviewable)
        return { ok: false, error: `${err.message}. The update itself will still run correctly.` }
      return { ok: false, error: (err as Error).message }
    }
    const c = this.collection(input.connectionId, input.ns)
    try {
      const before = await c
        .find(q.filter, {
          ...PRESERVE_TYPES,
          limit: input.limit ?? 5,
          collation: q.collation as never,
          maxTimeMS: 10_000
        })
        .toArray()
      const items = []
      for (const doc of before) {
        const [after] = await c
          .aggregate([{ $match: { _id: { $eq: doc['_id'] } } }, ...stages], {
            ...PRESERVE_TYPES,
            maxTimeMS: 10_000
          })
          .toArray()
        items.push({ before: toBsonBytes(doc), after: toBsonBytes(after ?? {}) })
      }
      return { ok: true, items }
    } catch (err) {
      return { ok: false, error: readableMessage(err) }
    }
  }
}

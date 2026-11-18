/**
 * How documents cross IPC: raw BSON bytes, one Uint8Array per document.
 *
 * BSON is MongoDB's own format, so nothing about a value's type can be lost on the way
 * (no Int64→Double, Decimal128→string, Date→string…). It is also ~15x cheaper than canonical
 * EJSON for object-heavy documents: no JSON-shaped object graph to build, clone and walk.
 * (Decision recorded in PLAN.md, Nov 2026; EJSON remains for clipboard/export text.)
 */
import { BSON, type Document } from 'bson'

/** Opaque marker: bytes of exactly one BSON document. */
export type BsonBytes = Uint8Array<ArrayBuffer>

/** Keep every value's BSON class: Int32, Long, Double, Binary, BSONRegExp… */
export const DESERIALIZE_OPTIONS = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
  useBigInt64: false
} as const

/**
 * Copies bytes into an ArrayBuffer of exactly their size. Driver buffers are views into the whole
 * server reply, and structured clone (IPC) copies a view's entire backing buffer.
 */
export function ownBytes(view: Uint8Array): BsonBytes {
  const copy = new Uint8Array(new ArrayBuffer(view.byteLength))
  copy.set(view)
  return copy
}

export function toBsonBytes(doc: Document): BsonBytes {
  return ownBytes(BSON.serialize(doc))
}

/** Byte size of each document as received, for size-aware rendering (e.g. huge documents). */
const sizes = new WeakMap<object, number>()

export function fromBsonBytes(bytes: Uint8Array): Document {
  const doc = BSON.deserialize(bytes, DESERIALIZE_OPTIONS)
  sizes.set(doc, bytes.byteLength)
  return doc
}

export function fromBsonArray(list: Uint8Array[]): Document[] {
  return list.map(fromBsonBytes)
}

/** BSON size of a document that arrived over IPC, if known. */
export function receivedSize(doc: object): number | undefined {
  return sizes.get(doc)
}

/**
 * Editing model for documents: immutable path operations, a type-exact diff, and the
 * conflict-safe update built from it (same strategy as Compass):
 *
 *   filter = { _id, <each changed path>: <its original value> }   ($exists: false for new paths)
 *   update = { $set: changed paths, $unset: removed paths }
 *
 * If anyone changed one of those fields since the document was loaded, the update matches 0
 * documents and the UI shows a conflict instead of silently overwriting their change.
 */
import { BSON, type Document } from 'bson'
import { bsonTypeOf } from './bson-types'

/** A path as segments: object keys (string) and array indices (number). Never a dotted string. */
export type Path = (string | number)[]

export interface DocDiff {
  set: [Path, unknown][]
  unset: Path[]
}

type Container = Record<string, unknown> | unknown[]

export function getAt(doc: unknown, path: Path): unknown {
  let cur: unknown = doc
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, unknown>)[seg]
  }
  return cur
}

function cloneShallow(c: Container): Container {
  return Array.isArray(c) ? [...c] : { ...c }
}

/** Returns a copy of `doc` with the container at `path` replaced by `fn(container)`. */
function updateContainer<T extends Document>(doc: T, path: Path, fn: (c: Container) => Container): T {
  if (!path.length) return fn(doc as Container) as T
  const [head, ...rest] = path
  const copy = cloneShallow(doc as Container) as Record<string | number, unknown>
  const child = copy[head!]
  if (child === null || typeof child !== 'object') throw new Error(`No object or array at ${path.join('.')}`)
  copy[head!] = updateContainer(child as Document, rest, fn)
  return copy as T
}

export function setAt<T extends Document>(doc: T, path: Path, value: unknown): T {
  const parent = path.slice(0, -1)
  const key = path[path.length - 1]!
  return updateContainer(doc, parent, (c) => {
    const copy = cloneShallow(c) as Record<string | number, unknown>
    copy[key] = value
    return copy as Container
  })
}

export function deleteAt<T extends Document>(doc: T, path: Path): T {
  const parent = path.slice(0, -1)
  const key = path[path.length - 1]!
  return updateContainer(doc, parent, (c) => {
    if (Array.isArray(c)) return c.filter((_, i) => i !== key)
    const copy = { ...c }
    delete copy[key as string]
    return copy
  })
}

/** Renames an object key, keeping its position. */
export function renameKey<T extends Document>(doc: T, parentPath: Path, from: string, to: string): T {
  return updateContainer(doc, parentPath, (c) => {
    if (Array.isArray(c)) throw new Error('Array elements have no names')
    if (from === to) return c
    if (Object.prototype.hasOwnProperty.call(c, to)) throw new Error(`A field named "${to}" already exists`)
    return Object.fromEntries(Object.entries(c).map(([k, v]) => [k === from ? to : k, v]))
  })
}

/**
 * Inserts into the container at `parentPath`: for arrays, `key` is the index; for objects, `key`
 * is the new field name and `position` its index among the keys (default: end).
 */
export function insertAt<T extends Document>(
  doc: T,
  parentPath: Path,
  key: string | number,
  value: unknown,
  position?: number
): T {
  return updateContainer(doc, parentPath, (c) => {
    if (Array.isArray(c)) {
      const copy = [...c]
      copy.splice(key as number, 0, value)
      return copy
    }
    if (Object.prototype.hasOwnProperty.call(c, key)) throw new Error(`A field named "${key}" already exists`)
    const entries = Object.entries(c)
    entries.splice(position ?? entries.length, 0, [key as string, value])
    return Object.fromEntries(entries)
  })
}

function bytes(v: unknown): Uint8Array {
  return BSON.serialize({ v })
}

/** Exact BSON equality: Int32(5) ≠ Int64(5) ≠ Double(5); Decimal "1.0" ≠ "1.00". */
export function sameValue(a: unknown, b: unknown): boolean {
  if (bsonTypeOf(a) !== bsonTypeOf(b)) return false
  const x = bytes(a)
  const y = bytes(b)
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

function diffInto(orig: unknown, edit: unknown, path: Path, out: DocDiff) {
  const ta = bsonTypeOf(orig)
  const tb = bsonTypeOf(edit)
  if (ta !== tb) {
    out.set.push([path, edit])
    return
  }
  if (ta === 'object') {
    const a = orig as Record<string, unknown>
    const b = edit as Record<string, unknown>
    for (const k of Object.keys(a))
      if (!Object.prototype.hasOwnProperty.call(b, k)) out.unset.push([...path, k])
    for (const k of Object.keys(b)) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) out.set.push([[...path, k], b[k]])
      else diffInto(a[k], b[k], [...path, k], out)
    }
    return
  }
  if (ta === 'array') {
    const a = orig as unknown[]
    const b = edit as unknown[]
    if (a.length !== b.length) {
      out.set.push([path, edit])
      return
    }
    for (let i = 0; i < a.length; i++) diffInto(a[i], b[i], [...path, i], out)
    return
  }
  if (!sameValue(orig, edit)) out.set.push([path, edit])
}

/** Changed paths between two versions of a document. Key order is ignored. */
export function diffDocuments(original: Document, edited: Document): DocDiff {
  const out: DocDiff = { set: [], unset: [] }
  diffInto(original, edited, [], out)
  // Unsets were collected per object before sets; order sets/unsets by discovery for stability.
  return out
}

export function isEmptyDiff(d: DocDiff): boolean {
  return d.set.length === 0 && d.unset.length === 0
}

/**
 * Dotted form of a path for $set/$unset and filters, or null when a segment can't be expressed
 * that way (contains ".", starts with "$", or is empty): those edits need a full replacement.
 */
export function toDottedPath(path: Path): string | null {
  for (const seg of path) {
    if (typeof seg === 'number') continue
    if (seg === '' || seg.includes('.') || seg.startsWith('$')) return null
  }
  return path.join('.')
}

export function diffNeedsReplacement(d: DocDiff): boolean {
  return [...d.set.map(([p]) => p), ...d.unset].some((p) => toDottedPath(p) === null)
}

export function updateFromDiff(d: DocDiff): { $set?: Document; $unset?: Document } {
  const update: { $set?: Document; $unset?: Document } = {}
  if (d.set.length) update.$set = Object.fromEntries(d.set.map(([p, v]) => [toDottedPath(p)!, v]))
  if (d.unset.length) update.$unset = Object.fromEntries(d.unset.map((p) => [toDottedPath(p)!, '']))
  return update
}

/** `_id` plus the original value of each changed path ($eq, so regexes match literally). */
export function conflictFilter(original: Document, d: DocDiff): Document {
  const filter: Document = { _id: { $eq: original['_id'] } }
  for (const [path] of d.set) {
    const before = getAt(original, path)
    filter[toDottedPath(path)!] = before === undefined ? { $exists: false } : { $eq: before }
  }
  for (const path of d.unset) filter[toDottedPath(path)!] = { $eq: getAt(original, path) }
  return filter
}

/** Filter matching the document only if it is still exactly the original (for full replacements). */
export function exactDocumentFilter(original: Document): Document {
  return { _id: { $eq: original['_id'] }, $expr: { $eq: ['$$ROOT', { $literal: original }] } }
}

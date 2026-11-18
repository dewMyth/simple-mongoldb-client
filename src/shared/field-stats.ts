/**
 * Field statistics over a set of documents: every dotted path (into nested objects and objects
 * inside arrays, MongoDB style: "items.sku"), how many documents contain it, and its BSON types.
 * Used for table columns now and query autocomplete later.
 */
import { bsonTypeOf, type BsonTypeTag } from './bson-types'

export interface FieldStat {
  path: string
  /** Number of path segments minus one (0 = top level). */
  depth: number
  /** Documents that contain the path at least once. */
  count: number
  /** count / total documents. */
  probability: number
  types: { type: BsonTypeTag; count: number }[]
}

export interface FieldStatsOptions {
  maxDepth?: number
  /** Stop collecting new paths beyond this many (wide/dynamic-key collections). */
  maxPaths?: number
}

interface Acc {
  order: number
  docs: number
  types: Map<BsonTypeTag, number>
}

export function collectFieldStats(docs: unknown[], options: FieldStatsOptions = {}): FieldStat[] {
  const maxDepth = options.maxDepth ?? 4
  const maxPaths = options.maxPaths ?? 1000
  const acc = new Map<string, Acc>()

  for (const doc of docs) {
    const seen = new Set<string>()
    const visit = (value: unknown, path: string, depth: number) => {
      const tag = bsonTypeOf(value)
      let a = acc.get(path)
      if (!a) {
        if (acc.size >= maxPaths) return
        a = { order: acc.size, docs: 0, types: new Map() }
        acc.set(path, a)
      }
      a.types.set(tag, (a.types.get(tag) ?? 0) + 1)
      if (!seen.has(path)) {
        seen.add(path)
        a.docs++
      }
      if (depth >= maxDepth) return
      if (tag === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>))
          visit(v, `${path}.${k}`, depth + 1)
      } else if (tag === 'array') {
        // Objects inside arrays contribute their fields under the array's path ("items.sku").
        for (const el of value as unknown[]) {
          if (bsonTypeOf(el) === 'object')
            for (const [k, v] of Object.entries(el as Record<string, unknown>))
              visit(v, `${path}.${k}`, depth + 1)
        }
      }
    }
    if (doc && typeof doc === 'object')
      for (const [k, v] of Object.entries(doc as Record<string, unknown>)) visit(v, k, 0)
  }

  const total = docs.length || 1
  return [...acc.entries()]
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([path, a]) => ({
      path,
      depth: path.split('.').length - 1,
      count: a.docs,
      probability: a.docs / total,
      types: [...a.types.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((x, y) => y.count - x.count)
    }))
}

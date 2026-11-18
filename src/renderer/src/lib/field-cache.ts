/**
 * Sampled fields per namespace for autocomplete: one $sample of 1,000 documents, cached until
 * refreshed (Refresh field suggestions) or for 10 minutes. Failures (e.g. no find permission)
 * yield an empty list so the editor still offers operators.
 */
import type { FieldStat } from '@shared/field-stats'
import { ipc } from './ipc'

const SAMPLE_SIZE = 1000
/** Distinct string values to keep per field (value suggestions). */
const MAX_VALUES = 50
const TTL = 10 * 60_000

export interface FieldSampleInfo {
  fields: FieldStat[]
  sampled: number
}

const cache = new Map<string, { at: number; promise: Promise<FieldSampleInfo> }>()
const key = (connectionId: string, ns: string) => `${connectionId}\u0000${ns}`

export function getFields(connectionId: string, ns: string): Promise<FieldSampleInfo> {
  const k = key(connectionId, ns)
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < TTL) return hit.promise
  const promise = ipc('schema:sampleFields', { connectionId, ns, size: SAMPLE_SIZE, maxValues: MAX_VALUES })
    .then((r) => ({ fields: r.fields, sampled: r.sampled }))
    .catch(() => {
      cache.delete(k)
      return { fields: [], sampled: 0 }
    })
  cache.set(k, { at: Date.now(), promise })
  return promise
}

export function refreshFields(connectionId: string, ns: string): Promise<FieldSampleInfo> {
  cache.delete(key(connectionId, ns))
  return getFields(connectionId, ns)
}

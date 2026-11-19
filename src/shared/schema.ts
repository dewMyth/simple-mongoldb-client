/** Schema analysis results (Schema tab), computed in main from a sample. */
import type { BsonTypeTag } from './bson-types'

export interface HistogramBin {
  /** Shell syntax for the bin's bounds, used to build a range filter. */
  loText: string
  hiText: string
  /** Short labels for the axis. */
  loLabel: string
  hiLabel: string
  count: number
}

export interface TopValue {
  /** The value in shell syntax, used to build an equality filter. */
  valueText: string
  label: string
  count: number
}

export type SchemaChart =
  | { kind: 'histogram'; valueKind: 'number' | 'date'; bins: HistogramBin[]; min: string; max: string }
  | { kind: 'top'; values: TopValue[]; distinct: number; sampled: number }

export interface SchemaTypeInfo {
  type: BsonTypeTag
  /** Share of the documents that have the field, with this type. */
  probability: number
  count: number
  chart: SchemaChart | null
  /** Arrays: average length. */
  averageLength?: number
}

export interface SchemaFieldInfo {
  /** Dotted path ("customer.address.city"); array elements share their array's path. */
  path: string
  name: string
  depth: number
  /** Share of the parent documents that have this field. */
  probability: number
  count: number
  types: SchemaTypeInfo[]
  children: SchemaFieldInfo[]
}

export interface SchemaResult {
  sampled: number
  fields: SchemaFieldInfo[]
  ms: number
}

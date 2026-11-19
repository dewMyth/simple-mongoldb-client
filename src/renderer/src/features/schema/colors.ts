import type { BsonTypeTag } from '@shared/bson-types'

/** Bar colour per BSON type (the same tokens as the JSON tree; light and dark). */
export const typeFill: Record<BsonTypeTag, string> = {
  string: 'var(--json-string)',
  int32: 'var(--json-number)',
  int64: 'var(--json-int64)',
  double: 'var(--json-double)',
  decimal128: 'var(--json-decimal)',
  boolean: 'var(--json-boolean)',
  date: 'var(--json-date)',
  objectId: 'var(--json-objectid)',
  null: 'var(--json-null)',
  undefined: 'var(--json-null)',
  binary: 'var(--json-binary)',
  uuid: 'var(--json-binary)',
  timestamp: 'var(--json-special)',
  regex: 'var(--json-regex)',
  minKey: 'var(--json-special)',
  maxKey: 'var(--json-special)',
  code: 'var(--json-special)',
  symbol: 'var(--json-special)',
  dbref: 'var(--json-special)',
  object: 'var(--json-punct)',
  array: 'var(--json-punct)'
}

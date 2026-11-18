import type { BsonTypeTag } from '@shared/bson-types'
import { toShellString } from '@shared/shell-format'

/** Tailwind text colour per BSON type (tokens in index.css; light and dark). */
export const typeColor: Record<BsonTypeTag, string> = {
  string: 'text-json-string',
  int32: 'text-json-number',
  int64: 'text-json-int64',
  double: 'text-json-double',
  decimal128: 'text-json-decimal',
  boolean: 'text-json-boolean',
  date: 'text-json-date',
  objectId: 'text-json-objectid',
  null: 'text-json-null italic',
  undefined: 'text-json-null italic',
  binary: 'text-json-binary',
  uuid: 'text-json-binary',
  timestamp: 'text-json-special',
  regex: 'text-json-regex',
  minKey: 'text-json-special',
  maxKey: 'text-json-special',
  code: 'text-json-special',
  symbol: 'text-json-special',
  dbref: 'text-json-special',
  object: 'text-json-punct',
  array: 'text-json-punct'
}

const shellCache = new WeakMap<object, string>()

/** Pretty shell syntax for a document, computed once per document object. */
export function shellText(doc: object): string {
  let text = shellCache.get(doc)
  if (text === undefined) {
    text = toShellString(doc)
    shellCache.set(doc, text)
  }
  return text
}

export function copyText(text: string): void {
  void navigator.clipboard.writeText(text)
}

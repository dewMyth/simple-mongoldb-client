/**
 * Query-bar parsing. User text is parsed by mongodb-query-parser (the parser Compass uses),
 * never eval'd. This module normalises its quirks:
 *  - unsupported expressions come back as '' instead of throwing → reported as errors
 *  - validators return 0 for "0" (falsy) → compared against `false` explicitly
 *  - isHintValid() doesn't accept index names → handled here
 *  - syntax error positions are relative to an internal "(\n…\n)" wrapper → mapped to user text
 */
import {
  isMaxTimeMSValid,
  isLimitValid,
  isSkipValid,
  parseCollation,
  parseFilter,
  parseProject,
  parseSort,
  toJSString
} from 'mongodb-query-parser'
import type { Document } from 'bson'
import type { QueryField, QueryFieldError, QueryText } from '@shared/query'

export type ObjectField = 'filter' | 'project' | 'sort' | 'collation'

export interface ParsedQuery {
  filter: Document
  project?: Document
  sort?: Document | [string, 1 | -1][]
  collation?: Document
  hint?: Document | string
  skip?: number
  limit?: number
  maxTimeMS?: number
}

const parsers: Record<ObjectField, (s: string) => unknown> = {
  filter: parseFilter,
  project: parseProject,
  sort: parseSort,
  collation: parseCollation
}

type FieldResult = { ok: true; value: unknown } | { ok: false; error: Omit<QueryFieldError, 'field'> }

const isPlainObject = (v: unknown): v is Document =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

function syntaxError(err: unknown): Omit<QueryFieldError, 'field'> {
  const e = err as Error & { loc?: { line: number; column: number } }
  const message = (e.message ?? String(err))
    .split('\n')[0]!
    .replace(/\s*in \($/, '')
    .trim()
  if (e.loc) {
    // The parser wraps input in "(\n" … "\n)", so line 2 is the user's line 1.
    return { message, line: Math.max(1, e.loc.line - 1), column: e.loc.column + 1 }
  }
  return { message }
}

export function parseQueryField(field: ObjectField, text: string): FieldResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: field === 'filter' ? {} : undefined }
  let value: unknown
  try {
    value = parsers[field](trimmed)
  } catch (err) {
    return { ok: false, error: syntaxError(err) }
  }
  // Sort may also be given as [[field, dir], …].
  if (field === 'sort' && Array.isArray(value)) return { ok: true, value }
  if (value === '' || value === undefined) {
    return {
      ok: false,
      error: {
        message:
          'Unsupported expression. Only literals, BSON constructors (ObjectId, ISODate, NumberLong…) and regexes are allowed; functions are never run.'
      }
    }
  }
  if (!isPlainObject(value))
    return { ok: false, error: { message: `The ${field} must be an object, like { field: value }` } }
  return { ok: true, value }
}

function parseHint(text: string): FieldResult {
  const t = text.trim()
  if (!t) return { ok: true, value: undefined }
  if (t.startsWith('{')) return parseQueryField('sort', t) // same shape as an index key pattern
  // Bare or quoted index name.
  const name = t.replace(/^(['"])(.*)\1$/, '$2')
  if (!name || /\s/.test(name))
    return { ok: false, error: { message: 'Hint must be an index name or a key pattern like { a: 1 }' } }
  return { ok: true, value: name }
}

function parseNumber(text: string, validator: (s: string) => number | false, message: string): FieldResult {
  const t = text.trim()
  if (!t) return { ok: true, value: undefined }
  const v = validator(t)
  if (v === false || !/^\d+$/.test(t)) return { ok: false, error: { message } }
  return { ok: true, value: v }
}

export function parseQuery(
  input: QueryText
): { ok: true; query: ParsedQuery } | { ok: false; errors: QueryFieldError[] } {
  const results: [QueryField, FieldResult][] = [
    ['filter', parseQueryField('filter', input.filter)],
    ['project', parseQueryField('project', input.project)],
    ['sort', parseQueryField('sort', input.sort)],
    ['collation', parseQueryField('collation', input.collation)],
    ['hint', parseHint(input.hint)],
    ['skip', parseNumber(input.skip, isSkipValid, 'Skip must be a whole number ≥ 0')],
    ['limit', parseNumber(input.limit, isLimitValid, 'Limit must be a whole number ≥ 0 (0 means no limit)')],
    [
      'maxTimeMS',
      parseNumber(input.maxTimeMS, isMaxTimeMSValid, 'maxTimeMS must be a whole number of milliseconds')
    ]
  ]
  const errors: QueryFieldError[] = []
  const query: Record<string, unknown> = {}
  for (const [field, r] of results) {
    if (!r.ok) errors.push({ field, ...r.error })
    else if (r.value !== undefined) query[field] = r.value
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, query: query as unknown as ParsedQuery }
}

/** Validates a single field for live editor squiggles. */
export function validateQueryField(field: QueryField, text: string): QueryFieldError | null {
  let r: FieldResult
  switch (field) {
    case 'hint':
      r = parseHint(text)
      break
    case 'skip':
      r = parseNumber(text, isSkipValid, 'Skip must be a whole number ≥ 0')
      break
    case 'limit':
      r = parseNumber(text, isLimitValid, 'Limit must be a whole number ≥ 0')
      break
    case 'maxTimeMS':
      r = parseNumber(text, isMaxTimeMSValid, 'maxTimeMS must be a whole number')
      break
    default:
      r = parseQueryField(field, text)
  }
  return r.ok ? null : { field, ...r.error }
}

/** Pretty-prints query text in shell syntax (types preserved). Null if it doesn't parse. */
export function formatQueryText(text: string, field: ObjectField = 'filter'): string | null {
  if (!text.trim()) return ''
  const r = parseQueryField(field, text)
  if (!r.ok) return null
  return toJSString(r.value, 2) ?? null
}

/** Parses any shell-syntax value (object or array), for document bodies and update specs. */
export function parseShellValue(text: string): FieldResultPublic {
  const t = text.trim()
  if (!t) return { ok: false, error: { message: 'Nothing to parse' } }
  let value: unknown
  try {
    value = parseFilter(t)
  } catch (err) {
    return { ok: false, error: syntaxError(err) }
  }
  if (value === '' || value === undefined)
    return {
      ok: false,
      error: {
        message:
          'Unsupported expression. Only literals, BSON constructors (ObjectId, ISODate, NumberLong…) and regexes are allowed; functions are never run.'
      }
    }
  return { ok: true, value }
}

export type FieldResultPublic = FieldResult

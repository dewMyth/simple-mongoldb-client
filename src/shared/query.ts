import { z } from 'zod'
import type { CanonicalEJSON } from './ejson'

export const queryFields = [
  'filter',
  'project',
  'sort',
  'collation',
  'hint',
  'skip',
  'limit',
  'maxTimeMS'
] as const
export type QueryField = (typeof queryFields)[number]

/** The raw text of every query-bar field, exactly as typed. */
export const queryTextSchema = z.object({
  filter: z.string().max(1_000_000).default(''),
  project: z.string().max(100_000).default(''),
  sort: z.string().max(100_000).default(''),
  collation: z.string().max(10_000).default(''),
  hint: z.string().max(10_000).default(''),
  skip: z.string().max(20).default(''),
  limit: z.string().max(20).default(''),
  maxTimeMS: z.string().max(20).default('')
})
export type QueryText = z.output<typeof queryTextSchema>

export const emptyQueryText: QueryText = {
  filter: '',
  project: '',
  sort: '',
  collation: '',
  hint: '',
  skip: '',
  limit: '',
  maxTimeMS: ''
}

export interface QueryFieldError {
  field: QueryField
  message: string
  /** 1-based, relative to the field's text. */
  line?: number
  column?: number
}

export function isQueryEmpty(q: QueryText): boolean {
  return Object.values(q).every((v) => !v.trim())
}

/** A count result. `exact: false` means the count timed out and `value` is a lower bound. */
export interface CountResult {
  value: number
  exact: boolean
  method: 'estimated' | 'countDocuments' | 'lowerBound'
}

export interface HistoryEntry {
  id: string
  query: QueryText
  ranAt: number
}

export interface FavoriteQuery {
  id: string
  name: string
  query: QueryText
  ns: string
  createdAt: number
}

export interface FindPage {
  docs: CanonicalEJSON[]
  exhausted: boolean
}

export type FindResult =
  | ({ ok: true; cursorId: string; parseMs: number; firstBatchMs: number } & FindPage)
  | { ok: false; errors: QueryFieldError[] }

/** Documents per page in the results view. */
export const PAGE_SIZE = 25

/** A page window, applied on top of the user's own skip/limit. */
export interface PageRequest {
  /** Index of the first document within the user's result set (0-based). */
  offset: number
  size: number
}

/**
 * Combines the user's skip/limit with a page window.
 * Returns null when the page lies entirely beyond the user's limit.
 */
export function pageWindow(
  user: { skip?: number; limit?: number },
  page: PageRequest
): { skip: number; limit: number } | null {
  const skip = (user.skip ?? 0) + page.offset
  const limit = user.limit ? Math.min(page.size, user.limit - page.offset) : page.size
  return limit > 0 ? { skip, limit } : null
}

/** Size of the user's result set given the filter count and their skip/limit. */
export function resultTotal(filterCount: number, user: { skip?: number; limit?: number }): number {
  const afterSkip = Math.max(0, filterCount - (user.skip ?? 0))
  return user.limit ? Math.min(afterSkip, user.limit) : afterSkip
}

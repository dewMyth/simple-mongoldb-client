import type { BsonBytes } from './bson-wire'

export type UpdateResult =
  | { status: 'updated'; doc: BsonBytes | null }
  | { status: 'unchanged' }
  /** The document changed (or was deleted) on the server since it was loaded. */
  | { status: 'conflict'; current: BsonBytes | null }

export interface InsertResult {
  insertedCount: number
  errors: { index: number; message: string }[]
}

export type ParseDocumentsResult =
  { ok: true; docs: BsonBytes[] } | { ok: false; error: { message: string; line?: number; column?: number } }

export type UpdatePreview =
  { ok: true; items: { before: BsonBytes; after: BsonBytes }[] } | { ok: false; error: string }

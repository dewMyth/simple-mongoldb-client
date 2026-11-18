/**
 * Every document that crosses IPC is canonical EJSON (hard rule 3). Use these helpers instead of
 * JSON.stringify so Int64, Decimal128, Binary subtypes, dates before 1970, etc. survive intact.
 */
import { EJSON, type Document } from 'bson'

/** A value that has been through EJSON.serialize in canonical mode. Opaque on purpose. */
export type CanonicalEJSON<T = unknown> = { readonly __canonical: T } & Record<string, unknown>

export function toCanonical<T>(value: T): CanonicalEJSON<T> {
  return EJSON.serialize(value as Document, { relaxed: false }) as CanonicalEJSON<T>
}

export function fromCanonical<T = Document>(value: CanonicalEJSON<T> | unknown): T {
  return EJSON.deserialize(value as Document, { relaxed: false }) as T
}

export function toCanonicalArray<T>(values: T[]): CanonicalEJSON<T>[] {
  return values.map((v) => toCanonical(v))
}

export function fromCanonicalArray<T = Document>(values: unknown[]): T[] {
  return values.map((v) => fromCanonical<T>(v))
}

/** Canonical EJSON text, for clipboard/export. */
export function stringifyCanonical(value: unknown, space?: number): string {
  return EJSON.stringify(value as Document, undefined, space, { relaxed: false })
}

/** Relaxed EJSON text (numbers as plain JSON numbers where safe). */
export function stringifyRelaxed(value: unknown, space?: number): string {
  return EJSON.stringify(value as Document, undefined, space, { relaxed: true })
}

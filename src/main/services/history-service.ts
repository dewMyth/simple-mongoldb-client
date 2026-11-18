/**
 * Query history (last 200 per connection + namespace) and saved/favourite queries.
 */
import { randomUUID } from 'node:crypto'
import type { FavoriteQuery, HistoryEntry, QueryText } from '@shared/query'
import { isQueryEmpty } from '@shared/query'

export const HISTORY_LIMIT = 200

export interface HistoryData {
  history: Record<string, HistoryEntry[]>
  favorites: FavoriteQuery[]
}

export interface HistoryBackend {
  get(): HistoryData
  set(data: HistoryData): void
}

const key = (connectionId: string, ns: string) => `${connectionId}|${ns}`
const same = (a: QueryText, b: QueryText) =>
  (Object.keys(a) as (keyof QueryText)[]).every((k) => a[k].trim() === b[k].trim())

export class HistoryService {
  constructor(private readonly backend: HistoryBackend) {}

  list(connectionId: string, ns: string): HistoryEntry[] {
    return this.backend.get().history[key(connectionId, ns)] ?? []
  }

  add(connectionId: string, ns: string, query: QueryText): HistoryEntry[] {
    if (isQueryEmpty(query)) return this.list(connectionId, ns)
    const data = this.backend.get()
    const k = key(connectionId, ns)
    // Re-running a query moves it to the top instead of duplicating it.
    const rest = (data.history[k] ?? []).filter((e) => !same(e.query, query))
    const next = [{ id: randomUUID(), query, ranAt: Date.now() }, ...rest].slice(0, HISTORY_LIMIT)
    this.backend.set({ ...data, history: { ...data.history, [k]: next } })
    return next
  }

  clear(connectionId: string, ns: string): void {
    const data = this.backend.get()
    const history = { ...data.history }
    delete history[key(connectionId, ns)]
    this.backend.set({ ...data, history })
  }

  listFavorites(ns?: string): FavoriteQuery[] {
    const all = this.backend.get().favorites
    return ns ? all.filter((f) => f.ns === ns) : all
  }

  saveFavorite(input: { id?: string; name: string; ns: string; query: QueryText }): FavoriteQuery {
    const data = this.backend.get()
    const existing = input.id ? data.favorites.find((f) => f.id === input.id) : undefined
    const fav: FavoriteQuery = {
      id: existing?.id ?? randomUUID(),
      name: input.name.trim() || 'Untitled query',
      ns: input.ns,
      query: input.query,
      createdAt: existing?.createdAt ?? Date.now()
    }
    const favorites = existing
      ? data.favorites.map((f) => (f.id === fav.id ? fav : f))
      : [...data.favorites, fav]
    this.backend.set({ ...data, favorites })
    return fav
  }

  deleteFavorite(id: string): void {
    const data = this.backend.get()
    this.backend.set({ ...data, favorites: data.favorites.filter((f) => f.id !== id) })
  }
}

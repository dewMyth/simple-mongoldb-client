/** Saved aggregation pipelines, per namespace. */
import { randomUUID } from 'node:crypto'
import type { PipelineOptions, PipelineStage, SavedPipeline } from '@shared/pipeline'

export interface PipelineLibraryBackend {
  get(): SavedPipeline[]
  set(value: SavedPipeline[]): void
}

export class PipelineLibrary {
  constructor(private readonly backend: PipelineLibraryBackend) {}

  list(ns: string): SavedPipeline[] {
    return this.backend
      .get()
      .filter((p) => p.ns === ns)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  save(input: {
    id?: string
    name: string
    ns: string
    stages: Omit<PipelineStage, 'id'>[]
    options: PipelineOptions
  }): SavedPipeline {
    const all = this.backend.get()
    const existing = input.id ? all.find((p) => p.id === input.id) : undefined
    const saved: SavedPipeline = {
      id: existing?.id ?? randomUUID(),
      name: input.name.trim() || 'Untitled pipeline',
      ns: input.ns,
      stages: input.stages.map(({ operator, body, enabled }) => ({ operator, body, enabled })),
      options: input.options,
      createdAt: existing?.createdAt ?? Date.now()
    }
    this.backend.set(existing ? all.map((p) => (p.id === saved.id ? saved : p)) : [...all, saved])
    return saved
  }

  delete(id: string): void {
    this.backend.set(this.backend.get().filter((p) => p.id !== id))
  }
}

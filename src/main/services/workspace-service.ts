/**
 * Persists the tab workspace (open tabs, their queries, split view) so it survives a restart.
 * Data is validated on the way in and on the way out: a corrupt file restores nothing rather
 * than breaking startup.
 */
import { workspaceSchema, type Workspace } from '@shared/workspace'

export interface WorkspaceBackend {
  get(): unknown
  set(value: Workspace | null): void
}

export class WorkspaceService {
  constructor(private readonly backend: WorkspaceBackend) {}

  load(): Workspace | null {
    const parsed = workspaceSchema.safeParse(this.backend.get())
    if (!parsed.success) return null
    const ws = parsed.data
    // Drop references to tabs that aren't there (hand-edited or partially written files).
    const ids = new Set(ws.tabs.map((t) => t.id))
    return {
      ...ws,
      activeId: ws.activeId && ids.has(ws.activeId) ? ws.activeId : (ws.tabs[0]?.id ?? null),
      split: ws.split && ids.has(ws.split.tabId) && ws.split.tabId !== ws.activeId ? ws.split : null
    }
  }

  save(ws: Workspace): void {
    this.backend.set(ws)
  }
}

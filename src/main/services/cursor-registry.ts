/**
 * Tracks every cancellable operation (open cursors and one-shot commands like counts) so they can
 * be killed on Esc, on tab close, on disconnect, or after sitting idle.
 *
 * Each operation is tagged with a unique `comment`, which lets cancel() find and killOp the
 * server-side operation even while the driver is still waiting for the first batch.
 */
import { randomUUID } from 'node:crypto'
import type { AbstractCursor, MongoClient } from 'mongodb'

export interface TrackedOp {
  id: string
  tabId: string | null
  connectionId: string
  comment: string
  controller: AbortController
  cursor?: AbstractCursor
  client: MongoClient
  lastUsed: number
  kind: 'cursor' | 'command'
}

const IDLE_TIMEOUT_MS = 10 * 60_000

export class CursorRegistry {
  private readonly ops = new Map<string, TrackedOp>()
  private sweeper: NodeJS.Timeout | null = null

  constructor(private readonly idleTimeoutMs = IDLE_TIMEOUT_MS) {}

  start(): void {
    this.sweeper ??= setInterval(() => void this.sweepIdle(), Math.min(60_000, this.idleTimeoutMs))
    this.sweeper.unref?.()
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }

  register(input: {
    client: MongoClient
    connectionId: string
    tabId?: string | null
    kind: TrackedOp['kind']
  }): TrackedOp {
    const id = randomUUID()
    const op: TrackedOp = {
      id,
      tabId: input.tabId ?? null,
      connectionId: input.connectionId,
      comment: `mongo-studio:${id}`,
      controller: new AbortController(),
      client: input.client,
      lastUsed: Date.now(),
      kind: input.kind
    }
    this.ops.set(id, op)
    return op
  }

  get(id: string): TrackedOp | undefined {
    const op = this.ops.get(id)
    if (op) op.lastUsed = Date.now()
    return op
  }

  /** Forget an operation that finished normally (cursor exhausted, count returned). */
  release(id: string): void {
    this.ops.delete(id)
  }

  has(id: string): boolean {
    return this.ops.has(id)
  }

  size(): number {
    return this.ops.size
  }

  /**
   * Kills the operation server-side (killOp by comment, then killCursors via close) and aborts
   * the client-side wait. Safe to call twice.
   */
  async cancel(id: string): Promise<boolean> {
    const op = this.ops.get(id)
    if (!op) return false
    this.ops.delete(id)
    // 1. Kill whatever is running server-side (e.g. a slow first batch).
    await killServerOps(op.client, op.comment)
    // 2. Close the cursor *before* aborting: close() sends killCursors, which an aborted signal skips.
    //    Bounded, because close() on a cursor whose first batch is still in flight waits for it.
    const closing = op.cursor?.close().catch(() => {})
    await Promise.race([closing, new Promise((r) => setTimeout(r, 1000))])
    // 3. Unblock anything still waiting client-side.
    op.controller.abort(new CancelledError())
    await closing
    return true
  }

  /**
   * Cancels a tab's operations. Sub-owners like "<tabId>#preview" belong to the tab too, so
   * closing the tab kills them, while cancelling "<tabId>#preview" leaves the tab's other work.
   */
  async cancelForTab(tabId: string): Promise<number> {
    const ids = [...this.ops.values()]
      .filter((o) => o.tabId === tabId || o.tabId?.startsWith(`${tabId}#`))
      .map((o) => o.id)
    await Promise.all(ids.map((id) => this.cancel(id)))
    return ids.length
  }

  async cancelForConnection(connectionId: string): Promise<void> {
    const ids = [...this.ops.values()].filter((o) => o.connectionId === connectionId).map((o) => o.id)
    await Promise.all(ids.map((id) => this.cancel(id)))
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.ops.keys()].map((id) => this.cancel(id)))
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleTimeoutMs
    const stale = [...this.ops.values()].filter((o) => o.kind === 'cursor' && o.lastUsed < cutoff)
    await Promise.all(stale.map((o) => this.cancel(o.id)))
  }
}

export class CancelledError extends Error {
  override name = 'CancelledError'
  constructor() {
    super('Operation cancelled')
  }
}

/** killOp every in-progress operation carrying this comment. Best effort. */
export async function killServerOps(client: MongoClient, comment: string): Promise<void> {
  try {
    const admin = client.db('admin')
    const ops = await admin
      .aggregate<{ opid: unknown }>([
        { $currentOp: { allUsers: false, idleConnections: false, localOps: true } },
        {
          $match: {
            $or: [
              { 'command.comment': comment },
              { 'command.explain.comment': comment },
              { 'cursor.originatingCommand.comment': comment }
            ]
          }
        },
        { $project: { opid: 1 } }
      ])
      .toArray()
    await Promise.all(ops.map((o) => admin.command({ killOp: 1, op: o.opid }).catch(() => {})))
  } catch {
    // $currentOp needs privileges some users lack ("inprog" on own ops is usually allowed).
    // Closing the cursor below still frees it once the first batch returns.
  }
}

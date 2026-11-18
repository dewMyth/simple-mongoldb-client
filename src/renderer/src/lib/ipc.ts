import { IpcError, type Channel, type ChannelInput, type ChannelOutput } from '@shared/ipc-contract'
import type { InvokeArgs } from '@shared/api'

/** Channels that change data on the server (the write guard runs before each). */
export const WRITE_CHANNELS = new Set<Channel>([
  'docs:update',
  'docs:insert',
  'docs:deleteOne',
  'docs:deleteMany',
  'docs:updateMany',
  'db:createCollection',
  'db:dropCollection',
  'db:dropDatabase',
  'agg:createView',
  // Only writes when the pipeline ends in $out/$merge (the guard checks).
  'agg:run'
])

/** Returns false to stop a write (e.g. the user declined a production confirmation). */
export type WriteGuard = <C extends Channel>(channel: C, input: ChannelInput<C>) => Promise<boolean>
let writeGuard: WriteGuard | null = null
export function setWriteGuard(guard: WriteGuard | null): void {
  writeGuard = guard
}

/** Typed IPC call. Throws IpcError (with server `code`) on failure. */
export async function ipc<C extends Channel>(channel: C, ...args: InvokeArgs<C>): Promise<ChannelOutput<C>> {
  if (writeGuard && WRITE_CHANNELS.has(channel) && !(await writeGuard(channel, args[0] as ChannelInput<C>)))
    throw new IpcError({ name: 'CancelledError', message: 'Write cancelled' })
  const envelope = await window.api.invoke(channel, ...args)
  if (envelope.ok) return envelope.data
  throw new IpcError(envelope.error)
}

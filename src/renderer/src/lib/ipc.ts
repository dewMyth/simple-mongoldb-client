import { IpcError, type Channel, type ChannelOutput } from '@shared/ipc-contract'
import type { InvokeArgs } from '@shared/api'

/** Typed IPC call. Throws IpcError (with server `code`) on failure. */
export async function ipc<C extends Channel>(channel: C, ...args: InvokeArgs<C>): Promise<ChannelOutput<C>> {
  const envelope = await window.api.invoke(channel, ...args)
  if (envelope.ok) return envelope.data
  throw new IpcError(envelope.error)
}

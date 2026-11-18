import type { Channel, ChannelInput, ChannelOutput, EventName, IpcEnvelope, IpcEvents } from './ipc-contract'

export type InvokeArgs<C extends Channel> = ChannelInput<C> extends void ? [] : [ChannelInput<C>]

/**
 * Shape of `window.api`, implemented by the preload.
 * `invoke` returns the raw envelope: errors thrown across contextBridge lose their custom fields
 * (e.g. MongoServerError.code), so the renderer's `ipc()` helper unwraps and re-throws.
 */
export interface Api {
  invoke<C extends Channel>(channel: C, ...args: InvokeArgs<C>): Promise<IpcEnvelope<ChannelOutput<C>>>
  on<E extends EventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
  platform: string
}

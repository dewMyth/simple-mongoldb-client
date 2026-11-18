import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  ipcContract,
  type Channel,
  type ChannelOutput,
  type IpcEnvelope,
  type SerializedError
} from '@shared/ipc-contract'

type Handler<C extends Channel> = (
  input: z.output<(typeof ipcContract)[C]['input']>,
  event: IpcMainInvokeEvent
) => Promise<ChannelOutput<C>> | ChannelOutput<C>

export function serializeError(err: unknown): SerializedError {
  if (err instanceof z.ZodError) {
    return { name: 'ValidationError', message: z.prettifyError(err), validation: true }
  }
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; codeName?: unknown }
    return {
      name: e.name,
      message: e.message,
      code: typeof e.code === 'number' ? e.code : undefined,
      codeName: typeof e.codeName === 'string' ? e.codeName : undefined
    }
  }
  return { name: 'Error', message: String(err) }
}

/** Wraps a handler with zod input validation and the error envelope. Exported for tests. */
export function wrapHandler<C extends Channel>(channel: C, handler: Handler<C>) {
  const schema = ipcContract[channel].input as z.ZodType
  return async (event: IpcMainInvokeEvent, raw: unknown): Promise<IpcEnvelope<ChannelOutput<C>>> => {
    try {
      const input = schema.parse(raw) as z.output<(typeof ipcContract)[C]['input']>
      return { ok: true, data: await handler(input, event) }
    } catch (err) {
      return { ok: false, error: serializeError(err) }
    }
  }
}

export function handle<C extends Channel>(channel: C, handler: Handler<C>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, wrapHandler(channel, handler))
}

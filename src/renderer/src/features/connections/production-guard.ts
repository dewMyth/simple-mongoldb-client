/**
 * Connections flagged "production" ask before every write. The check sits in the ipc() write
 * guard, so every write path (current and future) is covered without each caller opting in.
 * This is a safeguard against accidents, not a permission: permissions are enforced in main.
 */
import { create } from 'zustand'
import type { SavedConnection } from '@shared/connection'
import type { Channel, ChannelInput } from '@shared/ipc-contract'
import { isWriteStage } from '@shared/pipeline'
import { ipc, setWriteGuard } from '../../lib/ipc'
import { queryClient } from '../../lib/query-client'
import { keys } from './queries'

interface Request {
  connection: string
  action: string
  resolve: (ok: boolean) => void
}

export const useConfirmQueue = create<{ queue: Request[] }>(() => ({ queue: [] }))

function ask(connection: string, action: string): Promise<boolean> {
  return new Promise((resolve) =>
    useConfirmQueue.setState((s) => ({ queue: [...s.queue, { connection, action, resolve }] }))
  )
}

export function answer(ok: boolean) {
  const [first, ...rest] = useConfirmQueue.getState().queue
  if (!first) return
  useConfirmQueue.setState({ queue: rest })
  first.resolve(ok)
}

/** A sentence describing the write, e.g. "Insert 3 documents into shop.orders". */
export function describeWrite(channel: Channel, input: unknown): string {
  const i = input as { ns?: string; db?: string; name?: string; docs?: unknown[] }
  switch (channel) {
    case 'docs:update':
      return `Save changes to a document in ${i.ns}`
    case 'docs:insert': {
      const n = i.docs?.length ?? 1
      return `Insert ${n} document${n === 1 ? '' : 's'} into ${i.ns}`
    }
    case 'docs:deleteOne':
      return `Delete a document from ${i.ns}`
    case 'docs:deleteMany':
      return `Delete the matching documents in ${i.ns}`
    case 'docs:updateMany':
      return `Update the matching documents in ${i.ns}`
    case 'db:createCollection':
      return `Create the collection ${i.db}.${i.name}`
    case 'db:dropCollection':
      return `Drop the collection ${i.db}.${i.name}`
    case 'db:dropDatabase':
      return `Drop the database ${i.db}`
    case 'indexes:create':
      return `Create an index ${(input as { form: { keys: string } }).form.keys.trim()} on ${i.ns}`
    case 'indexes:drop':
      return `Drop the index ${i.name} on ${i.ns}`
    case 'indexes:setHidden':
      return `${(input as { hidden: boolean }).hidden ? 'Hide' : 'Unhide'} the index ${i.name} on ${i.ns}`
    case 'agg:createView':
      return `Create the view ${i.ns?.split('.')[0]}.${i.name}`
    case 'agg:run': {
      const last = (input as { stages?: { operator: string; body: string }[] }).stages?.at(-1)
      return `Run a pipeline that writes with ${last?.operator} ${last?.body.trim()} (from ${i.ns})`
    }
    default:
      return 'Write to the database'
  }
}

async function productionConnection(connectionId: string): Promise<SavedConnection | null> {
  const saved = await queryClient.fetchQuery({
    queryKey: keys.saved,
    queryFn: () => ipc('connections:list'),
    staleTime: Infinity
  })
  const conn = saved.find((c) => c.id === connectionId)
  return conn?.production ? conn : null
}

export function installProductionGuard(): void {
  setWriteGuard(async <C extends Channel>(channel: C, input: ChannelInput<C>) => {
    const connectionId = (input as { connectionId?: string } | undefined)?.connectionId
    if (!connectionId) return true
    if (channel === 'agg:run') {
      const last = (input as { stages: { operator: string }[] }).stages.at(-1)
      if (!last || !isWriteStage(last.operator)) return true // a read-only pipeline
    }
    const conn = await productionConnection(connectionId)
    if (!conn) return true
    return ask(conn.name, describeWrite(channel, input))
  })
}

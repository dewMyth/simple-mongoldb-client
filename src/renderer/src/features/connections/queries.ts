import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ActiveConnection, ConnectionDraft } from '@shared/connection'
import { ipc } from '../../lib/ipc'

export const keys = {
  saved: ['connections', 'saved'] as const,
  active: ['connections', 'active'] as const,
  databases: (connId: string) => ['db', connId, 'databases'] as const,
  collections: (connId: string, db: string) => ['db', connId, 'collections', db] as const,
  connection: (connId: string) => ['db', connId] as const
}

export function useSavedConnections() {
  return useQuery({ queryKey: keys.saved, queryFn: () => ipc('connections:list'), staleTime: Infinity })
}

/** Active connections, kept fresh by the main-process push event. */
export function useActiveConnections() {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.api.on('connections:activeChanged', (active) =>
        qc.setQueryData<ActiveConnection[]>(keys.active, active)
      ),
    [qc]
  )
  return useQuery({ queryKey: keys.active, queryFn: () => ipc('connections:active'), staleTime: Infinity })
}

export function useDatabases(connId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.databases(connId),
    queryFn: () => ipc('db:listDatabases', connId),
    enabled
  })
}

export function useCollections(connId: string, db: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.collections(connId, db),
    queryFn: () => ipc('db:listCollections', { connectionId: connId, db }),
    enabled
  })
}

export function useSaveConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (draft: ConnectionDraft) => ipc('connections:save', draft),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.saved })
  })
}

export function useConnect() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => ipc('connections:connect', id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.active })
      void qc.invalidateQueries({ queryKey: keys.saved })
    }
  })
}

export function useDisconnect() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => ipc('connections:disconnect', id),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: keys.connection(id) })
      void qc.invalidateQueries({ queryKey: keys.active })
    }
  })
}

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  can,
  canCreateDatabase,
  type PermissionAction,
  type PermissionCheck,
  type PermissionSnapshot
} from '@shared/permissions'
import { ipc } from '../../lib/ipc'

const key = (connectionId: string) => ['permissions', connectionId] as const

/** Keeps every connection's snapshot in the query cache, fed by main's push events. */
export function usePermissionEvents() {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.api.on('permissions:changed', (snapshot) =>
        qc.setQueryData<PermissionSnapshot | null>(key(snapshot.connectionId), snapshot)
      ),
    [qc]
  )
}

export function usePermissions(connectionId: string | undefined) {
  return useQuery({
    queryKey: key(connectionId ?? ''),
    queryFn: () => ipc('permissions:get', connectionId!),
    enabled: !!connectionId,
    staleTime: Infinity
  })
}

/** { allowed, reason } for an action on "db" or "db.collection". */
export function useCan(
  connectionId: string | undefined,
  ns: string,
  action: PermissionAction
): PermissionCheck {
  const { data } = usePermissions(connectionId)
  return can(data, ns, action)
}

export function useCanCreateDatabase(connectionId: string | undefined): PermissionCheck {
  const { data } = usePermissions(connectionId)
  return canCreateDatabase(data)
}

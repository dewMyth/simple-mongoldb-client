import type { PermissionCheck } from '@shared/permissions'
import { useCan } from '../../permissions/queries'
import { useDocsTarget } from '../docs-context'

/** Permission check for a write on the current collection, including "views are read-only". */
export function useWriteCheck(action: 'update' | 'insert' | 'remove'): PermissionCheck {
  const { connectionId, ns, readOnlyReason } = useDocsTarget()
  const check = useCan(connectionId, ns, action)
  if (readOnlyReason) return { allowed: false, reason: readOnlyReason }
  return check
}

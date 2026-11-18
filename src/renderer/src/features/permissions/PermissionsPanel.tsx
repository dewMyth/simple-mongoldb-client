import { useQueryClient } from '@tanstack/react-query'
import { Check, Lock, ShieldCheck, X } from 'lucide-react'
import {
  can,
  collectionActions,
  isReadOnly,
  type PermissionMode,
  type PermissionSnapshot
} from '@shared/permissions'
import { cn } from '@renderer/lib/utils'
import { Button } from '../../components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import { Switch } from '../../components/ui/switch'
import { Label } from '../../components/ui/label'
import { ipc } from '../../lib/ipc'
import { ReasonText } from '../../components/ReasonText'
import { keys } from '../connections/queries'
import { usePermissions } from './queries'

const actionLabel: Record<string, string> = {
  find: 'Read documents',
  insert: 'Insert documents',
  update: 'Edit documents',
  remove: 'Delete documents',
  createIndex: 'Create indexes',
  dropIndex: 'Drop indexes',
  createCollection: 'Create this collection',
  dropCollection: 'Drop this collection',
  collMod: 'Change collection options'
}

const modeDescription: Record<PermissionMode, string> = {
  privileges: 'Based on the privileges the server reported for your user.',
  noAuth: 'No user is logged in (authentication is off), so everything is allowed.',
  optimistic:
    "The server didn't report privileges, so actions are allowed until the server rejects one; then it's disabled for this session."
}

export function UserSummary({ snapshot }: { snapshot: PermissionSnapshot }) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div>
        <span className="text-muted-foreground">User: </span>
        {snapshot.users.length ? snapshot.users.map((u) => `${u.user}@${u.db}`).join(', ') : 'none'}
      </div>
      <div>
        <span className="text-muted-foreground">Roles: </span>
        {snapshot.roles.length ? snapshot.roles.map((r) => `${r.role} on ${r.db}`).join(', ') : 'none'}
      </div>
      <div className="text-muted-foreground">{modeDescription[snapshot.mode]}</div>
      {snapshot.statusError && (
        <div className="text-muted-foreground">connectionStatus failed: {snapshot.statusError}</div>
      )}
    </div>
  )
}

/** "Why can't I edit?": per-action access for one collection, plus the read-only switch. */
export function PermissionsPanel({ connectionId, ns }: { connectionId: string; ns: string }) {
  const qc = useQueryClient()
  const { data: snapshot } = usePermissions(connectionId)
  if (!snapshot) return null
  const readOnly = isReadOnly(snapshot)
  const blocked = collectionActions.filter((a) => !can(snapshot, ns, a).allowed).length

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-6 text-muted-foreground', readOnly && 'text-warn')}
          data-testid="permissions-button"
        >
          {readOnly ? <Lock /> : <ShieldCheck />}
          {readOnly ? 'Read-only' : blocked ? 'Limited access' : 'Full access'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0" data-testid="permissions-panel">
        <div className="border-b px-4 py-3">
          <div className="text-sm font-medium">Your access to {ns}</div>
          <div className="mt-2">
            <UserSummary snapshot={snapshot} />
          </div>
        </div>
        <ul className="flex flex-col gap-1.5 px-4 py-3 text-xs">
          {collectionActions.map((a) => {
            const res = can(snapshot, ns, a)
            return (
              <li
                key={a}
                className="flex items-start gap-2"
                data-testid={`perm-${a}`}
                data-allowed={res.allowed}
              >
                {res.allowed ? (
                  <Check className="mt-px size-3.5 shrink-0 text-ok" />
                ) : (
                  <X className="mt-px size-3.5 shrink-0 text-destructive" />
                )}
                <span className="flex flex-col">
                  <span>{actionLabel[a]}</span>
                  {!res.allowed && res.reason && (
                    <span className="text-muted-foreground">
                      <ReasonText text={res.reason} />
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
          <Label htmlFor="ro-switch" className="flex flex-col items-start gap-0.5 text-xs font-normal">
            <span className="font-medium">Read-only mode</span>
            <span className="text-muted-foreground">
              Blocks every write on this connection. It can only restrict, never grant.
            </span>
          </Label>
          <Switch
            id="ro-switch"
            checked={snapshot.readOnlyOverride}
            onCheckedChange={(v) =>
              void ipc('connections:setReadOnly', { id: connectionId, readOnly: v }).then(() =>
                qc.invalidateQueries({ queryKey: keys.saved })
              )
            }
            data-testid="readonly-switch"
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

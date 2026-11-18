import { useActiveConnections, useSavedConnections } from './queries'
import { usePermissions } from '../permissions/queries'
import { UserSummary } from '../permissions/PermissionsPanel'
import { redactUri } from '@shared/connection-fields'

export function ConnectionInfoPanel({ connectionId }: { connectionId: string }) {
  const { data: active = [] } = useActiveConnections()
  const { data: saved = [] } = useSavedConnections()
  const info = active.find((a) => a.id === connectionId)
  const conn = saved.find((c) => c.id === connectionId)
  const { data: snapshot } = usePermissions(connectionId)
  if (!info || !conn) return <div className="p-6 text-xs text-muted-foreground">Not connected.</div>
  const s = info.server
  const rows: [string, string][] = [
    ['Name', conn.name],
    ['Connection string', redactUri(conn.uri)],
    ['Server version', `${s.version}${s.isEnterprise ? ' (Enterprise)' : ''}`],
    [
      'Topology',
      `${s.isAtlas ? 'Atlas · ' : ''}${s.topology}${s.replicaSetName ? ` (${s.replicaSetName})` : ''}`
    ],
    ['Host', s.host],
    ['Latency', `${s.latencyMs} ms`],
    ['Connected at', new Date(info.connectedAt).toLocaleString()],
    ['Reads from secondaries', s.isSecondaryRead ? 'Yes (writes disabled)' : 'No']
  ]
  return (
    <div className="p-6">
      <h2 className="mb-4 text-sm font-semibold">Connection info</h2>
      <dl className="selectable grid max-w-3xl grid-cols-[180px_1fr] gap-y-2 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-mono text-xs break-all">{v}</dd>
          </div>
        ))}
      </dl>
      {snapshot && (
        <section className="mt-6 max-w-3xl">
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Access</h3>
          <UserSummary snapshot={snapshot} />
          {snapshot.readOnlyOverride && <p className="mt-2 text-xs text-warn">Read-only mode is on.</p>}
          {snapshot.secondaryReason && <p className="mt-2 text-xs text-warn">{snapshot.secondaryReason}</p>}
        </section>
      )}
    </div>
  )
}

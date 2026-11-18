/**
 * Indexes tab: every index with its keys, type, size and usage; create (with live build
 * progress), hide/unhide and drop, each permission-gated.
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeOff, Eye, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { IndexInfo, IndexKind } from '@shared/indexes'
import { cn } from '@renderer/lib/utils'
import type { Tab } from '../../stores/tabs'
import { ipc } from '../../lib/ipc'
import { formatBytes } from '../../lib/format'
import { Button } from '../../components/ui/button'
import { Spinner } from '../../components/ui/spinner'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { ErrorBox } from '../../components/form'
import { useCan } from '../permissions/queries'
import { CreateIndexDialog } from './CreateIndexDialog'
import { indexKeys } from './keys'

const kindLabel: Record<IndexKind, string> = {
  single: 'Single',
  compound: 'Compound',
  multikey: 'Multikey',
  text: 'Text',
  '2dsphere': '2dsphere',
  '2d': '2d',
  hashed: 'Hashed',
  wildcard: 'Wildcard',
  clustered: 'Clustered',
  ttl: 'TTL',
  partial: 'Partial',
  unique: 'Unique',
  sparse: 'Sparse',
  hidden: 'Hidden',
  collation: 'Collation'
}
const kindStyle: Partial<Record<IndexKind, string>> = {
  unique: 'bg-primary/10 text-primary',
  ttl: 'bg-warn/15 text-warn',
  hidden: 'bg-muted text-muted-foreground',
  partial: 'bg-purple-500/10 text-purple-600 dark:text-purple-300',
  text: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  '2dsphere': 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  '2d': 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  hashed: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  wildcard: 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
}

export function IndexesTab({ tab }: { tab: Tab }) {
  const qc = useQueryClient()
  const ns = tab.ns!
  const { connectionId } = tab
  const list = useQuery({
    queryKey: indexKeys.list(connectionId, ns),
    queryFn: () => ipc('indexes:list', { connectionId, ns })
  })
  const builds = useQuery({
    queryKey: indexKeys.builds(connectionId, ns),
    queryFn: () => ipc('indexes:builds', { connectionId, ns }),
    refetchInterval: 2000
  })
  const createCheck = useCan(connectionId, ns, 'createIndex')
  const [creating, setCreating] = useState(false)

  // When a build finishes (from here or elsewhere), refresh the list.
  const buildCount = builds.data?.length ?? 0
  const prevBuilds = useRef(0)
  useEffect(() => {
    if (prevBuilds.current > 0 && buildCount === 0)
      void qc.invalidateQueries({ queryKey: indexKeys.list(connectionId, ns) })
    prevBuilds.current = buildCount
  }, [buildCount, qc, connectionId, ns])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="indexes-tab">
      <div className="flex items-center gap-2 border-b bg-panel px-3 py-2">
        <span className="text-sm font-medium">Indexes</span>
        <span className="text-xs text-muted-foreground">{ns}</span>
        {list.data && <span className="text-xs text-muted-foreground">· {list.data.length}</span>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void list.refetch()} disabled={list.isFetching}>
          {list.isFetching ? <Spinner className="size-3" /> : <RefreshCw />} Refresh
        </Button>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          disabled={!createCheck.allowed}
          title={createCheck.allowed ? undefined : `Create index: ${createCheck.reason}`}
          data-testid="create-index"
        >
          <Plus /> Create index
        </Button>
      </div>

      {(builds.data ?? []).map((b) => (
        <div
          key={b.indexes.join(',')}
          className="flex items-center gap-3 border-b bg-primary/5 px-3 py-1.5 text-xs"
          data-testid="index-build"
        >
          <Spinner className="size-3" />
          <span className="font-medium">Building {b.indexes.join(', ')}</span>
          <span className="text-muted-foreground">{b.message}</span>
          {b.total ? (
            <span className="ml-auto flex items-center gap-2">
              <span className="h-1.5 w-40 overflow-hidden rounded bg-muted">
                <span
                  className="block h-full bg-primary"
                  style={{ width: `${Math.min(100, ((b.done ?? 0) / b.total) * 100)}%` }}
                />
              </span>
              {Math.round(((b.done ?? 0) / b.total) * 100)}%
            </span>
          ) : null}
        </div>
      ))}

      <div className="min-h-0 flex-1 overflow-auto">
        {list.error ? (
          <div className="p-3">
            <ErrorBox>{(list.error as Error).message}</ErrorBox>
          </div>
        ) : !list.data ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Spinner className="size-3" /> Loading indexes…
          </div>
        ) : (
          <table className="w-full border-collapse text-xs" data-testid="index-table">
            <thead className="sticky top-0 bg-panel text-left text-[11px] text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-1.5 font-medium">Name</th>
                <th className="px-3 py-1.5 font-medium">Keys</th>
                <th className="px-3 py-1.5 font-medium">Type and properties</th>
                <th className="px-3 py-1.5 text-right font-medium">Size</th>
                <th className="px-3 py-1.5 text-right font-medium">Usage</th>
                <th className="w-20 px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((ix) => (
                <IndexRow key={ix.name} ix={ix} tab={tab} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <CreateIndexDialog tab={tab} building={builds.data ?? []} onClose={() => setCreating(false)} />
      )}
    </div>
  )
}

function IndexRow({ ix, tab }: { ix: IndexInfo; tab: Tab }) {
  const qc = useQueryClient()
  const ns = tab.ns!
  const { connectionId } = tab
  const dropCheck = useCan(connectionId, ns, 'dropIndex')
  const hideCheck = useCan(connectionId, ns, 'collMod')
  const [dropping, setDropping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hidden = ix.kinds.includes('hidden')
  const isId = ix.name === '_id_'
  const refresh = () => qc.invalidateQueries({ queryKey: indexKeys.list(connectionId, ns) })

  return (
    <tr className="border-b align-top hover:bg-accent/30" data-testid={`index-${ix.name}`}>
      <td className="px-3 py-2">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn('font-mono font-medium hover:underline', hidden && 'text-muted-foreground')}
            >
              {ix.name}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[28rem]" align="start">
            <div className="mb-1 text-xs font-medium">Index definition</div>
            <pre className="selectable max-h-72 overflow-auto rounded bg-panel-2 p-2 font-mono text-[11px] whitespace-pre-wrap">
              {ix.specText}
            </pre>
          </PopoverContent>
        </Popover>
        {error && <div className="mt-1 text-destructive">{error}</div>}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {ix.fields.map((f) => (
            <span key={f.field} className="rounded border bg-background px-1.5 py-px font-mono text-[11px]">
              {f.field}: <span className="text-primary">{f.value}</span>
            </span>
          ))}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1" data-testid="index-kinds">
          {ix.kinds.map((k) => (
            <span
              key={k}
              className={cn(
                'rounded px-1.5 py-px text-[10px] font-medium',
                kindStyle[k] ?? 'bg-secondary text-secondary-foreground'
              )}
              title={
                k === 'ttl'
                  ? `Documents expire ${ix.ttlSeconds} s after the indexed date`
                  : k === 'partial'
                    ? `Only documents matching ${ix.partialFilterText}`
                    : k === 'collation'
                      ? `Collation ${ix.collationText}`
                      : k === 'wildcard' && ix.wildcardProjectionText
                        ? `Projection ${ix.wildcardProjectionText}`
                        : k === 'text' && ix.weightsText
                          ? `Weights ${ix.weightsText}`
                          : undefined
              }
            >
              {kindLabel[k]}
              {k === 'ttl' ? ` ${ix.ttlSeconds}s` : ''}
            </span>
          ))}
        </div>
        {ix.partialFilterText && (
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">{ix.partialFilterText}</div>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{ix.size === null ? '—' : formatBytes(ix.size)}</td>
      <td
        className="px-3 py-2 text-right tabular-nums"
        title={ix.usage ? `Since ${new Date(ix.usage.since).toLocaleString()}` : 'Needs $indexStats access'}
      >
        {ix.usage ? `${ix.usage.ops.toLocaleString()} ops` : '—'}
      </td>
      <td className="px-3 py-1.5">
        {!isId && (
          <div className="flex justify-end gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={hidden ? `Unhide ${ix.name}` : `Hide ${ix.name}`}
              title={
                hideCheck.allowed
                  ? hidden
                    ? 'Unhide: let the planner use it again'
                    : 'Hide from the query planner (keeps the index)'
                  : hideCheck.reason
              }
              disabled={!hideCheck.allowed}
              onClick={() => {
                setError(null)
                void ipc('indexes:setHidden', { connectionId, ns, name: ix.name, hidden: !hidden })
                  .then(refresh)
                  .catch((e: Error) => e.name !== 'CancelledError' && setError(e.message))
              }}
              data-testid="toggle-hidden"
            >
              {hidden ? <Eye /> : <EyeOff />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Drop ${ix.name}`}
              title={dropCheck.allowed ? 'Drop index' : dropCheck.reason}
              disabled={!dropCheck.allowed}
              onClick={() => setDropping(true)}
              className="hover:text-destructive"
              data-testid="drop-index"
            >
              <Trash2 />
            </Button>
          </div>
        )}
        <ConfirmDialog
          open={dropping}
          onOpenChange={setDropping}
          title="Drop index"
          body={
            <>
              Drop <b>{ix.name}</b> on {ns}? Queries that use it will get slower. Hiding it first is a safer
              way to test.
            </>
          }
          typeToConfirm={ix.name}
          confirmLabel="Drop"
          onConfirm={async () => {
            await ipc('indexes:drop', { connectionId, ns, name: ix.name })
            await refresh()
          }}
        />
      </td>
    </tr>
  )
}

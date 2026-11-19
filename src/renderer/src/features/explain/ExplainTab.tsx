/**
 * Explain tab: runs explain("executionStats") for the exact query or pipeline it was opened
 * with, then shows a summary, hints with a one-click suggested index, the stage tree and the
 * raw output.
 */
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ChevronRight, Play, RefreshCw, Square, Zap } from 'lucide-react'
import type { ExplainResult, PlanNode } from '@shared/explain'
import { emptyCreateIndexForm } from '@shared/indexes'
import { fromBsonBytes } from '@shared/bson-wire'
import { cn } from '@renderer/lib/utils'
import { useTabsStore, type Tab } from '../../stores/tabs'
import { ipc } from '../../lib/ipc'
import { Button } from '../../components/ui/button'
import { Spinner } from '../../components/ui/spinner'
import { ErrorBox } from '../../components/form'
import { useCan } from '../permissions/queries'
import { JsonTree } from '../documents/JsonTree'
import { indexKeys } from '../indexes/keys'
import { openIndexes } from '../indexes/open'

const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString())

export function ExplainTab({ tab }: { tab: Tab }) {
  const qc = useQueryClient()
  const patch = useTabsStore((s) => s.patch)
  const ns = tab.ns!
  const explain = tab.explain
  const key = explain ? JSON.stringify(explain) : ''
  const [creating, setCreating] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const createCheck = useCan(tab.connectionId, ns, 'createIndex')

  // Runs when opened or asked again (`at` is in the key); restored tabs wait for the button.
  const q = useQuery({
    queryKey: ['explain', tab.id, key],
    queryFn: () =>
      ipc('explain:run', { connectionId: tab.connectionId, ns, tabId: tab.id, source: explain!.source }),
    enabled: !!explain && tab.autoRun,
    retry: false,
    staleTime: Infinity,
    gcTime: 0
  })
  const cancelled = (q.error as Error | null)?.name === 'CancelledError'
  const status: 'idle' | 'running' | 'done' | 'error' = q.isFetching
    ? 'running'
    : q.data && !q.error
      ? 'done'
      : q.error && !cancelled
        ? 'error'
        : 'idle'
  const run = () => {
    setCreateError(null)
    if (tab.autoRun) void q.refetch()
    else patch(tab.id, { autoRun: true })
  }

  const createSuggested = async (keyText: string) => {
    setCreating(keyText)
    try {
      await ipc('indexes:create', {
        connectionId: tab.connectionId,
        ns,
        form: { ...emptyCreateIndexForm, keys: keyText }
      })
      await qc.invalidateQueries({ queryKey: indexKeys.list(tab.connectionId, ns) })
      if (explain) patch(tab.id, { explain: { ...explain, at: Date.now() }, autoRun: true }) // re-run
    } catch (e) {
      const err = e as Error
      if (err.name !== 'CancelledError') setCreateError(`Creating the index failed: ${err.message}`)
    } finally {
      setCreating(null)
    }
  }

  const source = explain?.source
  const sourceText =
    source?.kind === 'find'
      ? [
          source.query.filter.trim() || '{}',
          ...(['sort', 'project', 'hint', 'limit'] as const)
            .filter((k) => source.query[k].trim())
            .map((k) => `${k}: ${source.query[k].trim()}`)
        ].join('  ·  ')
      : source
        ? source.stages.map((s) => s.operator).join(' → ') || '(empty pipeline)'
        : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="explain-tab">
      <div className="flex items-center gap-2 border-b bg-panel px-3 py-2">
        <span className="text-sm font-medium">Explain</span>
        <span className="rounded bg-secondary px-1.5 py-px text-[10px] font-medium">
          {source?.kind === 'aggregate' ? 'aggregate' : 'find'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={sourceText}>
          {sourceText}
        </span>
        <Button size="sm" variant="ghost" onClick={() => openIndexes(tab.connectionId, ns)}>
          Indexes
        </Button>
        {status === 'running' ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void ipc('ops:cancelForTab', tab.id)}
            data-testid="cancel-explain"
          >
            <Square size={11} /> Cancel
          </Button>
        ) : (
          <Button size="sm" onClick={run} disabled={!explain} data-testid="rerun-explain">
            {status === 'idle' ? <Play size={11} /> : <RefreshCw />}{' '}
            {status === 'idle' ? 'Run explain' : 'Re-run'}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {createError && <ErrorBox>{createError}</ErrorBox>}
        {status === 'idle' && (
          <div className="py-10 text-center text-xs text-muted-foreground">
            Explain runs the query with execution statistics. Press “Run explain”.
          </div>
        )}
        {status === 'running' && (
          <div className="flex items-center gap-2 py-10 text-xs text-muted-foreground">
            <Spinner className="size-3" /> Running explain (executionStats runs the query)…
          </div>
        )}
        {status === 'error' && <ErrorBox error={q.error}>{(q.error as Error).message}</ErrorBox>}
        {status === 'done' && (
          <Result
            result={q.data!}
            creating={creating}
            canCreate={createCheck}
            onCreate={(k) => void createSuggested(k)}
          />
        )}
      </div>
    </div>
  )
}

function Result({
  result,
  creating,
  canCreate,
  onCreate
}: {
  result: ExplainResult
  creating: string | null
  canCreate: { allowed: boolean; reason?: string }
  onCreate: (keyText: string) => void
}) {
  const s = result.summary
  const [showRaw, setShowRaw] = useState(false)
  const raw = useMemo(() => fromBsonBytes(result.raw), [result.raw])
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-5 gap-2" data-testid="explain-summary">
        <Stat label="Execution time" value={s.executionTimeMs === null ? '—' : `${s.executionTimeMs} ms`} />
        <Stat label="Returned" value={fmt(s.nReturned)} />
        <Stat
          label="Documents examined"
          value={fmt(s.docsExamined)}
          warn={!!s.docsExamined && (s.docsExamined ?? 0) > (s.nReturned ?? 0) * 10}
        />
        <Stat label="Keys examined" value={fmt(s.keysExamined)} />
        <div
          className={cn(
            'rounded-md border p-2.5',
            s.collscan ? 'border-destructive/50 bg-destructive/5' : 'bg-card'
          )}
          data-testid="explain-index"
        >
          <div className="text-[11px] text-muted-foreground">Index used</div>
          {s.collscan ? (
            <div className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-destructive">
              <AlertTriangle size={14} /> COLLSCAN
            </div>
          ) : s.indexes.length ? (
            <div className="mt-0.5 flex items-center gap-1.5 font-mono text-sm font-semibold text-ok">
              <CheckCircle2 size={14} /> {s.indexes.join(', ')}
            </div>
          ) : (
            <div className="mt-0.5 text-sm text-muted-foreground">None</div>
          )}
        </div>
      </div>

      {result.notes.map((n) => (
        <div key={n} className="text-xs text-muted-foreground">
          {n}
        </div>
      ))}

      {(result.hints.length > 0 || result.suggestion) && (
        <div className="rounded-md border border-warn/40 bg-warn/5 p-3" data-testid="explain-hints">
          {result.hints.map((h) => (
            <div key={h.kind} className="flex items-start gap-2 text-xs">
              <AlertTriangle size={13} className="mt-px shrink-0 text-warn" />
              <span>{h.message}</span>
            </div>
          ))}
          {result.suggestion && !result.suggestion.exists && (
            <div
              className="mt-2.5 flex items-center gap-3 border-t border-warn/30 pt-2.5"
              data-testid="index-suggestion"
            >
              <Zap size={14} className="text-primary" />
              <span className="text-xs">Suggested index</span>
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">
                {result.suggestion.keyText}
              </code>
              <span className="flex-1" />
              <Button
                size="sm"
                onClick={() => onCreate(result.suggestion!.keyText)}
                disabled={!!creating || !canCreate.allowed}
                title={
                  canCreate.allowed ? 'Create it and run explain again' : `Create index: ${canCreate.reason}`
                }
                data-testid="create-suggested-index"
              >
                {creating ? <Spinner className="size-3" /> : <Zap />}{' '}
                {creating ? 'Creating…' : 'Create index'}
              </Button>
            </div>
          )}
        </div>
      )}

      <div>
        <div className="mb-1.5 text-xs font-medium">
          Plan{' '}
          <span className="font-normal text-muted-foreground">
            (top runs last; {s.engine === 'sbe' ? 'slot-based engine' : 'classic engine'})
          </span>
        </div>
        <div className="rounded-md border bg-card p-2" data-testid="explain-tree">
          <PlanNodeView node={result.tree} />
        </div>
      </div>

      <div>
        <button
          type="button"
          className="flex items-center gap-1 text-xs font-medium"
          onClick={() => setShowRaw(!showRaw)}
          data-testid="toggle-raw-explain"
        >
          <ChevronRight size={13} className={cn('transition-transform', showRaw && 'rotate-90')} /> Raw
          explain output
        </button>
        {showRaw && (
          <div className="mt-1.5 rounded-md border bg-card" data-testid="raw-explain">
            <JsonTree doc={raw} epoch={0} mode="default" />
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={cn('rounded-md border bg-card p-2.5', warn && 'border-warn/50')}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-sm font-semibold tabular-nums', warn && 'text-warn')}>{value}</div>
    </div>
  )
}

const stageColor: Record<PlanNode['kind'], string> = {
  collscan: 'border-destructive/60 bg-destructive/5',
  ixscan: 'border-ok/60 bg-ok/5',
  sort: 'border-warn/60 bg-warn/5',
  stage: 'border-primary/30 bg-primary/5',
  other: 'border-border bg-background'
}

function PlanNodeView({ node }: { node: PlanNode }) {
  const metrics = [
    node.nReturned !== null && `${node.nReturned.toLocaleString()} returned`,
    node.docsExamined !== null && `${node.docsExamined.toLocaleString()} docs examined`,
    node.keysExamined !== null && `${node.keysExamined.toLocaleString()} keys examined`,
    node.ms !== null && `${node.ms} ms`
  ].filter(Boolean)
  return (
    <div className="flex flex-col">
      <div
        className={cn('rounded border px-2.5 py-1.5', stageColor[node.kind])}
        data-testid="plan-node"
        data-stage={node.stage}
      >
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-mono text-xs font-semibold">{node.stage}</span>
          {metrics.length > 0 && (
            <span className="text-[11px] text-muted-foreground">{metrics.join(' · ')}</span>
          )}
        </div>
        {node.details.map((d) => (
          <div key={d} className="truncate font-mono text-[11px] text-muted-foreground" title={d}>
            {d}
          </div>
        ))}
      </div>
      {node.children.length > 0 && (
        <div className="ml-4 flex flex-col gap-1.5 border-l-2 border-border pt-1.5 pl-3">
          {node.children.map((c, i) => (
            <PlanNodeView key={i} node={c} />
          ))}
        </div>
      )}
    </div>
  )
}

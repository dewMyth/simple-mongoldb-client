/**
 * Aggregation builder tab: stage cards with live per-stage previews, a lossless text mode,
 * options, saved pipelines, export to code, "create view", and full runs ($out/$merge only here).
 */
import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Code2, Eye, Gauge, Play, Plus, RefreshCw, Settings2, Square, Trash2 } from 'lucide-react'
import {
  isWriteStage,
  newPipelineState,
  newStageId,
  stagesToText,
  textToStages,
  withIds,
  type PipelineRunResult,
  type PipelineStage,
  type PipelineState,
  type StageInput
} from '@shared/pipeline'
import { cn } from '@renderer/lib/utils'
import { useTabsStore, type Tab } from '../../stores/tabs'
import { ipc } from '../../lib/ipc'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Switch } from '../../components/ui/switch'
import { Checkbox } from '../../components/ui/checkbox'
import { Label } from '../../components/ui/label'
import { Spinner } from '../../components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../../components/ui/dropdown-menu'
import { CodeEditor } from '../../components/CodeEditor'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Dialog } from '../../components/Dialog'
import { ErrorBox, Field } from '../../components/form'
import { ExportCodeDialog } from '../query-bar/ExportCodeDialog'
import { useActiveConnections, keys } from '../connections/queries'
import { useCan } from '../permissions/queries'
import { openExplain } from '../indexes/open'
import { PreviewPane, StageCard, StageOperatorList } from './StageCard'
import { usePreviews } from './use-previews'

type RunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: PipelineRunResult }
  | { status: 'error'; message: string }

/** The enabled stages, as they would run (either mode). */
function runnableStages(
  state: PipelineState
): { ok: true; stages: StageInput[] } | { ok: false; error: string } {
  if (state.mode === 'text') {
    const r = textToStages(state.text)
    if (!r.ok) return { ok: false, error: r.error }
    return {
      ok: true,
      stages: r.stages.filter((s) => s.enabled).map(({ operator, body }) => ({ operator, body }))
    }
  }
  return {
    ok: true,
    stages: state.stages.filter((s) => s.enabled).map(({ operator, body }) => ({ operator, body }))
  }
}

export function AggregationTab({ tab }: { tab: Tab }) {
  const setPipeline = useTabsStore((s) => s.setPipeline)
  const qc = useQueryClient()
  const ns = tab.ns!
  const db = ns.slice(0, ns.indexOf('.'))
  const [initial] = useState(newPipelineState)
  const state = tab.pipeline ?? initial
  const update = useCallback(
    (fn: (s: PipelineState) => PipelineState) => {
      const cur = useTabsStore.getState().tabs.find((t) => t.id === tab.id)?.pipeline ?? initial
      setPipeline(tab.id, fn(cur))
    },
    [setPipeline, tab.id, initial]
  )
  const target = useMemo(
    () => ({ tabId: tab.id, connectionId: tab.connectionId, ns }),
    [tab.id, tab.connectionId, ns]
  )
  const previews = usePreviews(target, state)
  const { data: active = [] } = useActiveConnections()
  const server = active.find((a) => a.id === tab.connectionId)?.server
  const isAtlas = !!(server?.isAtlas || server?.isLocalAtlas)

  const [modeError, setModeError] = useState<string | null>(null)
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const [dialog, setDialog] = useState<null | 'export' | 'view' | 'save' | 'confirm-write'>(null)

  // ------------------------------------------------------------ stage operations
  const changeStage = useCallback(
    (id: string, patch: Partial<PipelineStage>) =>
      update((s) => ({ ...s, stages: s.stages.map((st) => (st.id === id ? { ...st, ...patch } : st)) })),
    [update]
  )
  const deleteStage = useCallback(
    (id: string) => update((s) => ({ ...s, stages: s.stages.filter((st) => st.id !== id) })),
    [update]
  )
  const insertAfter = useCallback(
    (id: string | null, stage?: PipelineStage) =>
      update((s) => {
        const idx = id ? s.stages.findIndex((st) => st.id === id) : s.stages.length - 1
        const next = [...s.stages]
        next.splice(idx + 1, 0, stage ?? { id: newStageId(), operator: '$match', body: '{}', enabled: true })
        return { ...s, stages: next }
      }),
    [update]
  )
  const duplicateStage = useCallback(
    (id: string) => {
      const src = state.stages.find((st) => st.id === id)
      if (src) insertAfter(id, { ...src, id: newStageId() })
    },
    [state.stages, insertAfter]
  )
  const moveStage = useCallback(
    (id: string, to: number) =>
      update((s) => {
        const from = s.stages.findIndex((st) => st.id === id)
        if (from < 0 || to < 0 || to >= s.stages.length) return s
        const next = [...s.stages]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved!)
        return { ...s, stages: next }
      }),
    [update]
  )
  const dropStage = useCallback(
    (draggedId: string, targetId: string, position: 'before' | 'after') =>
      update((s) => {
        const dragged = s.stages.find((st) => st.id === draggedId)
        if (!dragged) return s
        const rest = s.stages.filter((st) => st.id !== draggedId)
        const idx = rest.findIndex((st) => st.id === targetId)
        rest.splice(position === 'before' ? idx : idx + 1, 0, dragged)
        return { ...s, stages: rest }
      }),
    [update]
  )

  // ------------------------------------------------------------ modes
  const switchMode = (mode: 'stages' | 'text') => {
    if (mode === state.mode) return
    if (mode === 'text') {
      setModeError(null)
      update((s) => ({ ...s, mode, text: stagesToText(s.stages) }))
      return
    }
    const r = textToStages(state.text)
    if (!r.ok) {
      setModeError(`Can’t switch to stages: ${r.error}${r.line ? ` (line ${r.line})` : ''}`)
      return
    }
    setModeError(null)
    update((s) => ({ ...s, mode, stages: withIds(r.stages) }))
  }

  // ------------------------------------------------------------ run
  const runnable = runnableStages(state)
  const lastOp = runnable.ok ? runnable.stages.at(-1)?.operator : undefined
  const writes = !!lastOp && isWriteStage(lastOp)
  const insertCheck = useCan(tab.connectionId, ns, 'insert')
  const viewCheck = useCan(tab.connectionId, db, 'createCollection')

  const doRun = async () => {
    if (!runnable.ok) return setRun({ status: 'error', message: runnable.error })
    setRun({ status: 'running' })
    try {
      const result = await ipc('agg:run', {
        connectionId: tab.connectionId,
        ns,
        tabId: tab.id,
        stages: runnable.stages,
        options: state.options
      })
      setRun({ status: 'done', result })
      if (result.kind === 'written')
        void qc.invalidateQueries({
          queryKey: keys.collections(tab.connectionId, result.target.split('.')[0]!)
        })
    } catch (e) {
      const err = e as Error
      setRun(err.name === 'CancelledError' ? { status: 'idle' } : { status: 'error', message: err.message })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="aggregation-tab">
      <StageOperatorList />
      <div className="flex flex-wrap items-center gap-2 border-b bg-panel px-3 py-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={state.mode}
          onValueChange={(m) => m && switchMode(m as 'stages' | 'text')}
        >
          <ToggleGroupItem value="stages" className="px-2.5 text-xs" data-testid="mode-stages">
            Stages
          </ToggleGroupItem>
          <ToggleGroupItem value="text" className="px-2.5 text-xs" data-testid="mode-text">
            Text
          </ToggleGroupItem>
        </ToggleGroup>
        {state.mode === 'stages' && (
          <Button size="sm" variant="outline" onClick={() => insertAfter(null)} data-testid="add-stage">
            <Plus /> Add stage
          </Button>
        )}
        <span className="mx-1 h-5 w-px bg-border" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={state.autoPreview}
            onCheckedChange={(v) => update((s) => ({ ...s, autoPreview: v }))}
            aria-label="Auto-preview"
            data-testid="auto-preview"
          />
          Auto-preview
        </label>
        <Button
          size="sm"
          variant="ghost"
          onClick={previews.refresh}
          title="Preview now"
          data-testid="preview-now"
        >
          {previews.loading ? <Spinner className="size-3" /> : <RefreshCw />} Preview
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Sample
          <Input
            className="h-7 w-16 font-mono text-xs"
            inputMode="numeric"
            value={String(state.sampleSize)}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isInteger(n) && n >= 1 && n <= 1000) update((s) => ({ ...s, sampleSize: n }))
            }}
            data-testid="sample-size"
          />
        </label>
        <OptionsPopover state={state} update={update} />
        <span className="flex-1" />
        <SavedPipelinesMenu
          ns={ns}
          state={state}
          update={update}
          onSave={() => setTimeout(() => setDialog('save'))}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            runnable.ok &&
            openExplain(tab.connectionId, ns, {
              kind: 'aggregate',
              stages: runnable.stages,
              options: state.options
            })
          }
          disabled={!runnable.ok}
          title="Explain the pipeline (a final $out/$merge is left out)"
          data-testid="explain-pipeline"
        >
          <Gauge /> Explain
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDialog('export')}
          disabled={!runnable.ok}
          data-testid="export-pipeline"
        >
          <Code2 /> Export
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDialog('view')}
          disabled={!runnable.ok || writes || !viewCheck.allowed}
          title={
            !viewCheck.allowed
              ? `Create view: ${viewCheck.reason}`
              : writes
                ? 'A view can’t end in $out/$merge'
                : 'Create a view from this pipeline'
          }
          data-testid="create-view"
        >
          <Eye /> Create view
        </Button>
        {run.status === 'running' ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void ipc('ops:cancelForTab', tab.id)}
            data-testid="cancel-run"
          >
            <Square size={11} /> Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => (writes ? setDialog('confirm-write') : void doRun())}
            disabled={!runnable.ok || (writes && !insertCheck.allowed)}
            title={writes && !insertCheck.allowed ? `Writing: ${insertCheck.reason}` : undefined}
            variant={writes ? 'destructive' : 'default'}
            data-testid="run-pipeline"
          >
            <Play size={11} /> {writes ? `Run with ${lastOp}` : 'Run full pipeline'}
          </Button>
        )}
      </div>
      {(modeError || previews.error) && (
        <div className="border-b px-3 py-1.5 text-xs text-destructive" data-testid="pipeline-error">
          {modeError ?? previews.error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {state.mode === 'stages' ? (
          <div className="flex flex-col gap-3 p-3" data-testid="stage-list">
            {state.stages.map((st, i) => (
              <StageCard
                key={st.id}
                stage={st}
                index={i}
                count={state.stages.length}
                preview={previews.byId[st.id]}
                loading={previews.loading && st.enabled}
                stale={previews.stale}
                connectionId={tab.connectionId}
                ns={ns}
                isAtlas={isAtlas}
                onChange={changeStage}
                onDelete={deleteStage}
                onDuplicate={duplicateStage}
                onMove={moveStage}
                onAddAfter={insertAfter}
                onDropStage={dropStage}
              />
            ))}
            {!state.stages.length && (
              <div className="flex flex-col items-center gap-2 py-10 text-xs text-muted-foreground">
                The pipeline is empty.
                <Button size="sm" variant="outline" onClick={() => insertAfter(null)}>
                  <Plus /> Add a stage
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="grid min-h-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="border-r p-3">
              <CodeEditor
                value={state.text}
                onChange={(text) => update((s) => ({ ...s, text }))}
                minLines={14}
                maxHeight={2000}
                completion={{ mode: 'pipeline', connectionId: tab.connectionId, ns }}
                testId="pipeline-text"
              />
            </div>
            <div className="flex min-h-0 flex-col">
              <div className="flex h-8 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
                Output (sample of {state.sampleSize}){previews.loading && <Spinner className="size-3" />}
              </div>
              <PreviewPane preview={previews.firstError ?? previews.last} />
            </div>
          </div>
        )}
      </div>

      {run.status !== 'idle' && <RunResults run={run} tab={tab} onClose={() => setRun({ status: 'idle' })} />}

      {dialog === 'export' && runnable.ok && (
        <ExportCodeDialog
          ns={ns}
          source={{ kind: 'aggregate', stages: runnable.stages, options: state.options }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'view' && runnable.ok && (
        <CreateViewDialog tab={tab} stages={runnable.stages} onClose={() => setDialog(null)} />
      )}
      {dialog === 'save' && <SavePipelineDialog ns={ns} state={state} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'confirm-write'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Run ${lastOp}?`}
        body={
          <>
            This runs the whole pipeline and <b>writes</b> its results with <code>{lastOp}</code>
            {lastOp === '$out' ? ', replacing the target collection' : ' into the target collection'}.
          </>
        }
        confirmLabel="Run and write"
        onConfirm={async () => {
          setDialog(null)
          await doRun()
        }}
      />
    </div>
  )
}

function OptionsPopover({
  state,
  update
}: {
  state: PipelineState
  update: (fn: (s: PipelineState) => PipelineState) => void
}) {
  const o = state.options
  const set = (patch: Partial<PipelineState['options']>) =>
    update((s) => ({ ...s, options: { ...s.options, ...patch } }))
  const count = [o.allowDiskUse, o.maxTimeMS, o.collation, o.comment].filter(Boolean).length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" data-testid="pipeline-options">
          <Settings2 /> Options{count ? ` (${count})` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-80 flex-col gap-3 text-xs" align="start">
        <div className="flex items-center gap-2">
          <Checkbox
            id="allowDiskUse"
            checked={o.allowDiskUse}
            onCheckedChange={(v) => set({ allowDiskUse: v === true })}
          />
          <Label htmlFor="allowDiskUse" className="text-xs font-normal">
            allowDiskUse (large sorts and groups)
          </Label>
        </div>
        <Field label="maxTimeMS">
          <Input
            className="h-7 font-mono text-xs"
            value={o.maxTimeMS}
            placeholder="Previews: 10000"
            onChange={(e) => set({ maxTimeMS: e.target.value })}
          />
        </Field>
        <Field label="Collation">
          <Input
            className="h-7 font-mono text-xs"
            value={o.collation}
            placeholder="{ locale: 'en', strength: 2 }"
            onChange={(e) => set({ collation: e.target.value })}
          />
        </Field>
        <Field label="Comment">
          <Input
            className="h-7 text-xs"
            value={o.comment}
            placeholder="Shows in logs and the profiler"
            onChange={(e) => set({ comment: e.target.value })}
          />
        </Field>
      </PopoverContent>
    </Popover>
  )
}

function SavedPipelinesMenu({
  ns,
  state,
  update,
  onSave
}: {
  ns: string
  state: PipelineState
  update: (fn: (s: PipelineState) => PipelineState) => void
  onSave: () => void
}) {
  const qc = useQueryClient()
  const { data: saved = [] } = useQuery({
    queryKey: ['pipelines', ns],
    queryFn: () => ipc('pipelines:list', ns)
  })
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" data-testid="saved-pipelines">
          <Bookmark /> Saved
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 text-xs">
        <DropdownMenuItem className="text-xs" onSelect={onSave} data-testid="save-pipeline">
          Save pipeline…
        </DropdownMenuItem>
        {saved.length > 0 && <DropdownMenuSeparator />}
        {saved.length > 0 && (
          <DropdownMenuLabel className="text-[10px] tracking-wide text-muted-foreground uppercase">
            Load
          </DropdownMenuLabel>
        )}
        {saved.map((p) => (
          <DropdownMenuItem
            key={p.id}
            className="group text-xs"
            onSelect={() =>
              update(() => {
                const stages = withIds(p.stages)
                return {
                  ...state,
                  stages,
                  options: p.options,
                  text: state.mode === 'text' ? stagesToText(stages) : state.text
                }
              })
            }
            data-testid={`load-pipeline-${p.name}`}
          >
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="text-muted-foreground">{p.stages.length} stages</span>
            <button
              type="button"
              aria-label={`Delete ${p.name}`}
              className="hidden text-muted-foreground group-hover:block hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation()
                void ipc('pipelines:delete', p.id).then(() =>
                  qc.invalidateQueries({ queryKey: ['pipelines', ns] })
                )
              }}
            >
              <Trash2 size={12} />
            </button>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SavePipelineDialog({
  ns,
  state,
  onClose
}: {
  ns: string
  state: PipelineState
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const stages =
      state.mode === 'text'
        ? (() => {
            const r = textToStages(state.text)
            if (!r.ok) throw new Error(r.error)
            return r.stages
          })()
        : state.stages.map(({ operator, body, enabled }) => ({ operator, body, enabled }))
    await ipc('pipelines:save', { name, ns, stages, options: state.options })
    await qc.invalidateQueries({ queryKey: ['pipelines', ns] })
    onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Save pipeline"
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void save().catch((e: Error) => setError(e.message))}
            data-testid="save-pipeline-submit"
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Revenue by SKU"
          data-testid="save-pipeline-name"
          onKeyDown={(e) => e.key === 'Enter' && void save().catch((err: Error) => setError(err.message))}
        />
      </Field>
      {error && <ErrorBox>{error}</ErrorBox>}
    </Dialog>
  )
}

function CreateViewDialog({ tab, stages, onClose }: { tab: Tab; stages: StageInput[]; onClose: () => void }) {
  const qc = useQueryClient()
  const open = useTabsStore((s) => s.open)
  const ns = tab.ns!
  const db = ns.slice(0, ns.indexOf('.'))
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const viewNs = await ipc('agg:createView', {
        connectionId: tab.connectionId,
        ns,
        name: name.trim(),
        stages
      })
      await qc.invalidateQueries({ queryKey: keys.collections(tab.connectionId, db) })
      onClose()
      open({ type: 'documents', connectionId: tab.connectionId, ns: viewNs, title: name.trim() })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Create view"
      description={`A read-only view in ${db} that runs this pipeline on ${ns}.`}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void create()}
            disabled={!name.trim() || busy}
            data-testid="create-view-submit"
          >
            {busy && <Spinner className="size-3" />} Create view
          </Button>
        </>
      }
    >
      <Field label="View name">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="view-name" />
      </Field>
      {error && <ErrorBox>{error}</ErrorBox>}
    </Dialog>
  )
}

function RunResults({ run, tab, onClose }: { run: RunState; tab: Tab; onClose: () => void }) {
  const open = useTabsStore((s) => s.open)
  return (
    <div className="flex max-h-[45%] min-h-32 shrink-0 flex-col border-t" data-testid="run-results">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-panel px-3 text-xs">
        <span className="font-medium">Result</span>
        {run.status === 'running' && (
          <>
            <Spinner className="size-3" /> Running the full pipeline…
          </>
        )}
        {run.status === 'done' && run.result.kind === 'docs' && (
          <span className="text-muted-foreground" data-testid="run-summary">
            {run.result.more
              ? `First ${run.result.docs.length} documents (more available)`
              : `${run.result.docs.length} document${run.result.docs.length === 1 ? '' : 's'}`}{' '}
            · {run.result.ms} ms
          </span>
        )}
        {run.status === 'done' && run.result.kind === 'written' && (
          <span className="text-ok" data-testid="run-summary">
            Wrote the results to {run.result.target} · {run.result.ms} ms
          </span>
        )}
        <span className="flex-1" />
        {run.status === 'done' && run.result.kind === 'written' && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6"
            onClick={() => {
              const t = (run.result as { target: string }).target
              open({
                type: 'documents',
                connectionId: tab.connectionId,
                ns: t,
                title: t.slice(t.indexOf('.') + 1)
              })
            }}
          >
            Open {run.result.target}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-6" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className={cn('min-h-0 flex-1 overflow-auto')}>
        {run.status === 'error' && (
          <div className="p-3">
            <ErrorBox>{run.message}</ErrorBox>
          </div>
        )}
        {run.status === 'done' && run.result.kind === 'docs' && (
          <PreviewPane preview={{ status: 'ok', docs: run.result.docs, ms: run.result.ms }} />
        )}
      </div>
    </div>
  )
}

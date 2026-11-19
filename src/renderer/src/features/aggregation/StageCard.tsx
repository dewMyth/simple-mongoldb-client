/**
 * One pipeline stage: operator, enable switch, body editor (with stage-aware completions) and
 * the preview of the pipeline's output up to this stage.
 */
import { memo, useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { AlertTriangle, ChevronRight, Copy, GripVertical, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import { isAtlasStage, isWriteStage, type PipelineStage, type StagePreview } from '@shared/pipeline'
import { STAGES } from '@shared/autocomplete/operators'
import { fromBsonBytes } from '@shared/bson-wire'
import { cn } from '@renderer/lib/utils'
import { CodeEditor, type EditorError } from '../../components/CodeEditor'
import { Switch } from '../../components/ui/switch'
import { Button } from '../../components/ui/button'
import { Spinner } from '../../components/ui/spinner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../../components/ui/dropdown-menu'
import { ipc } from '../../lib/ipc'
import { JsonTree } from '../documents/JsonTree'

export interface StageCardProps {
  stage: PipelineStage
  index: number
  count: number
  preview: StagePreview | undefined
  loading: boolean
  stale: boolean
  connectionId: string
  ns: string
  isAtlas: boolean
  onChange: (id: string, patch: Partial<PipelineStage>) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onMove: (id: string, to: number) => void
  onAddAfter: (id: string) => void
  /** Drag and drop reordering: `position` is where the dragged stage lands. */
  onDropStage: (draggedId: string, targetId: string, position: 'before' | 'after') => void
}

const DRAG_TYPE = 'application/x-mongo-studio-stage'
const STAGE_NAMES = STAGES.map((s) => s.name)

export const StageCard = memo(function StageCard(p: StageCardProps) {
  const { stage } = p
  const [collapsed, setCollapsed] = useState(false)
  const [dropAt, setDropAt] = useState<'before' | 'after' | null>(null)
  const [syntaxError, setSyntaxError] = useState<EditorError | null>(null)
  const write = isWriteStage(stage.operator)

  // Live syntax check of the body (parsed in main).
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      if (!stage.body.trim()) return
      void ipc('agg:validateStage', { operator: stage.operator, body: stage.body })
        .then((e) => !cancelled && setSyntaxError(e))
        .catch(() => {})
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [stage.operator, stage.body])

  const completion = useMemo(
    () => ({ mode: 'stage' as const, stage: stage.operator, connectionId: p.connectionId, ns: p.ns }),
    [stage.operator, p.connectionId, p.ns]
  )

  const half = (e: DragEvent): 'before' | 'after' => {
    const box = e.currentTarget.getBoundingClientRect()
    return e.clientY < box.top + box.height / 2 ? 'before' : 'after'
  }
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    e.stopPropagation()
    setDropAt(half(e))
  }
  const onDrop = (e: DragEvent) => {
    const id = e.dataTransfer.getData(DRAG_TYPE)
    // From the drop itself, not the dragover state: a quick drop can land before that re-renders.
    const at = half(e)
    setDropAt(null)
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    if (id !== stage.id) p.onDropStage(id, stage.id, at)
  }

  return (
    <div
      className={cn(
        'relative rounded-md border bg-card',
        !stage.enabled && 'opacity-60',
        dropAt === 'before' && 'shadow-[0_-2px_0_var(--primary)]',
        dropAt === 'after' && 'shadow-[0_2px_0_var(--primary)]'
      )}
      // Capture phase: Monaco would otherwise take the drop as text.
      onDragOverCapture={onDragOver}
      onDragLeave={() => setDropAt(null)}
      onDropCapture={onDrop}
      data-testid="stage-card"
      data-stage-id={stage.id}
      data-operator={stage.operator}
    >
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, stage.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          className="cursor-grab text-muted-foreground active:cursor-grabbing"
          title="Drag to reorder"
          data-testid="stage-drag"
        >
          <GripVertical size={14} />
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="text-muted-foreground"
          aria-label={collapsed ? 'Expand stage' : 'Collapse stage'}
        >
          <ChevronRight size={13} className={cn('transition-transform', !collapsed && 'rotate-90')} />
        </button>
        <span className="text-xs font-medium text-muted-foreground">Stage {p.index + 1}</span>
        <input
          aria-label="Stage operator"
          list="stage-operators"
          value={stage.operator}
          onChange={(e) => p.onChange(stage.id, { operator: e.target.value.trim() })}
          className="h-6 w-40 rounded border border-input bg-background px-1.5 font-mono text-xs outline-none focus:border-ring"
          data-testid="stage-operator"
        />
        <label className="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={stage.enabled}
            onCheckedChange={(v) => p.onChange(stage.id, { enabled: v })}
            aria-label="Stage enabled"
            data-testid="stage-enabled"
          />
          {stage.enabled ? 'On' : 'Off'}
        </label>
        <span className="flex-1" />
        <PreviewStatus
          preview={p.preview}
          loading={p.loading}
          stale={p.stale}
          enabled={stage.enabled}
          write={write}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Add stage after"
          onClick={() => p.onAddAfter(stage.id)}
        >
          <Plus />
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Stage actions" data-testid="stage-menu">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-xs">
            <DropdownMenuItem className="text-xs" onSelect={() => p.onDuplicate(stage.id)}>
              <Copy size={12} /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-xs"
              disabled={p.index === 0}
              onSelect={() => p.onMove(stage.id, p.index - 1)}
            >
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-xs"
              disabled={p.index === p.count - 1}
              onSelect={() => p.onMove(stage.id, p.index + 1)}
              data-testid="stage-move-down"
            >
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-xs"
              variant="destructive"
              onSelect={() => p.onDelete(stage.id)}
              data-testid="stage-delete"
            >
              <Trash2 size={12} /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!collapsed && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-0">
          <div className="border-r p-2">
            <CodeEditor
              value={stage.body}
              onChange={(body) => p.onChange(stage.id, { body })}
              error={syntaxError}
              minLines={4}
              maxHeight={320}
              autoFocus={false}
              completion={completion}
              testId="stage-editor"
            />
            {syntaxError && <div className="pt-1 text-[11px] text-destructive">{syntaxError.message}</div>}
            {write && (
              <Note>
                {stage.operator} writes to a collection. It never runs in previews; use “Run full pipeline”.
              </Note>
            )}
            {isAtlasStage(stage.operator) && !p.isAtlas && (
              <Note>{stage.operator} only runs on MongoDB Atlas (or a local Atlas deployment).</Note>
            )}
          </div>
          <PreviewPane preview={p.preview} enabled={stage.enabled} write={write} />
        </div>
      )}
    </div>
  )
})

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-warn" data-testid="stage-note">
      <AlertTriangle size={12} className="mt-px shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function PreviewStatus({
  preview,
  loading,
  stale,
  enabled,
  write
}: {
  preview: StagePreview | undefined
  loading: boolean
  stale: boolean
  enabled: boolean
  write: boolean
}) {
  if (!enabled) return <span className="text-[11px] text-muted-foreground">Disabled</span>
  if (write) return <span className="text-[11px] text-warn">Not previewed</span>
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="stage-status">
      {loading && <Spinner className="size-3" />}
      {preview?.status === 'ok' && (
        <span className={cn(stale && 'opacity-60')}>
          {preview.docs.length} document{preview.docs.length === 1 ? '' : 's'} · {preview.ms} ms
        </span>
      )}
      {preview?.status === 'error' && <span className="text-destructive">Error</span>}
    </span>
  )
}

export function PreviewPane({
  preview,
  enabled = true,
  write = false
}: {
  preview: StagePreview | undefined | null
  enabled?: boolean
  write?: boolean
}) {
  const docs = useMemo(
    () => (preview?.status === 'ok' ? preview.docs.map((b) => fromBsonBytes(b)) : []),
    [preview]
  )
  let body: ReactNode
  if (!enabled) body = <Empty>This stage is off: it’s skipped when the pipeline runs.</Empty>
  else if (write) body = <Empty>Output of {`$out/$merge`} isn’t previewed.</Empty>
  else if (!preview) body = <Empty>No preview yet.</Empty>
  else if (preview.status === 'error')
    body = (
      <div className="p-2 text-xs text-destructive" data-testid="stage-error">
        {preview.message}
      </div>
    )
  else if (preview.status === 'skipped')
    body = (
      <Empty>
        {preview.reason === 'write'
          ? 'Not previewed: an earlier stage writes ($out/$merge).'
          : 'Fix the earlier stage to see this preview.'}
      </Empty>
    )
  else if (!docs.length) body = <Empty>No documents.</Empty>
  else
    body = (
      <div className="flex flex-col gap-1.5 p-2">
        {docs.map((d, i) => (
          <div key={i} className="rounded border bg-background">
            <JsonTree doc={d} epoch={0} mode="default" />
          </div>
        ))}
      </div>
    )
  return (
    <div className="max-h-[360px] min-h-24 overflow-auto bg-panel/40" data-testid="stage-preview">
      {body}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-24 items-center justify-center p-3 text-xs text-muted-foreground">
      {children}
    </div>
  )
}

/** Shared <datalist> of stage names for the operator inputs. */
export function StageOperatorList() {
  return (
    <datalist id="stage-operators">
      {STAGE_NAMES.map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  )
}

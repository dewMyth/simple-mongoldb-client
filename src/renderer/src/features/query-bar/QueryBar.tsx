import { useCallback, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Code2, History, MoreHorizontal, Play, RotateCcw, Square, Star } from 'lucide-react'
import { emptyQueryText, isQueryEmpty, type QueryField, type QueryText } from '@shared/query'
import { cn } from '@renderer/lib/utils'
import { Field } from '../../components/form'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../../components/ui/dropdown-menu'
import { Dialog } from '../../components/Dialog'
import { ipc } from '../../lib/ipc'
import { getFields, refreshFields, type FieldSampleInfo } from '../../lib/field-cache'
import { QueryEditor } from './QueryEditor'
import { ExportCodeDialog } from './ExportCodeDialog'

const OBJECT_FIELDS = ['filter', 'project', 'sort', 'collation'] as const
type ObjectField = (typeof OBJECT_FIELDS)[number]

const fieldLabel: Record<QueryField, string> = {
  filter: 'Filter',
  project: 'Project',
  sort: 'Sort',
  collation: 'Collation',
  hint: 'Hint',
  skip: 'Skip',
  limit: 'Limit',
  maxTimeMS: 'Max time MS'
}

function summary(q: QueryText): string {
  const parts = (Object.keys(q) as QueryField[])
    .filter((k) => q[k].trim())
    .map((k) => (k === 'filter' ? q[k].trim() : `${k}: ${q[k].trim()}`))
  return parts.join('  ·  ') || '{}'
}

export function QueryBar({
  connectionId,
  ns,
  query,
  onChange,
  onRun,
  onCancel,
  running,
  fieldErrors
}: {
  connectionId: string
  ns: string
  query: QueryText
  onChange: (q: QueryText) => void
  onRun: (q?: QueryText) => void
  onCancel: () => void
  running: boolean
  fieldErrors: { field: QueryField; message: string; line?: number; column?: number }[]
}) {
  const qc = useQueryClient()
  const namespace = useMemo(() => ({ connectionId, ns }), [connectionId, ns])
  const [showOptions, setShowOptions] = useState(() =>
    (['project', 'sort', 'collation', 'hint', 'skip', 'limit', 'maxTimeMS'] as const).some((k) => query[k])
  )
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [toolError, setToolError] = useState<string | null>(null)
  const [sample, setSample] = useState<FieldSampleInfo | null>(null)

  /** Rewrites every non-empty object field; fields that don't parse are left as they are. */
  const rewrite = async (fn: (field: ObjectField, text: string) => Promise<string | null>) => {
    const next = { ...query }
    const failed: string[] = []
    for (const f of OBJECT_FIELDS) {
      if (!query[f].trim()) continue
      const out = await fn(f, query[f])
      if (out === null) failed.push(fieldLabel[f])
      else next[f] = out
    }
    onChange(next)
    setToolError(failed.length ? `Couldn't convert ${failed.join(', ')}: fix the errors first.` : null)
  }
  const convert = (to: 'shell' | 'canonical' | 'relaxed') =>
    void rewrite((field, text) => ipc('query:convert', { field, text, to }))
  const historyIndex = useRef(-1)
  const draftBeforeHistory = useRef<string>('')

  const historyKey = ['history', connectionId, ns]
  const { data: history = [] } = useQuery({
    queryKey: historyKey,
    queryFn: () => ipc('history:list', { connectionId, ns })
  })
  const { data: favorites = [] } = useQuery({
    queryKey: ['favorites', ns],
    queryFn: () => ipc('favorites:list', ns)
  })

  const set = (field: QueryField, value: string) => {
    historyIndex.current = -1
    onChange({ ...query, [field]: value })
  }

  const run = useCallback(() => {
    historyIndex.current = -1
    onRun()
  }, [onRun])

  const handlers = useMemo(
    () => ({
      onRun: run,
      onCancel,
      /** ↑ walks back through history, ↓ walks forward, past the newest restores the draft. */
      onHistory: (dir: 'up' | 'down') => {
        if (!history.length) return null
        if (historyIndex.current === -1) {
          if (dir === 'down') return null
          draftBeforeHistory.current = query.filter
        }
        const next = historyIndex.current + (dir === 'up' ? 1 : -1)
        if (next >= history.length) return null
        historyIndex.current = next
        if (next < 0) {
          historyIndex.current = -1
          onChange({ ...query, filter: draftBeforeHistory.current })
          return draftBeforeHistory.current
        }
        const entry = history[next]!.query
        onChange({ ...emptyQueryText, ...entry })
        if (
          (['project', 'sort', 'collation', 'hint', 'skip', 'limit', 'maxTimeMS'] as const).some(
            (k) => entry[k]
          )
        )
          setShowOptions(true)
        return entry.filter
      }
    }),
    [run, onCancel, history, query, onChange]
  )

  const errorFor = (f: QueryField) => fieldErrors.find((e) => e.field === f) ?? null

  const load = (q: QueryText) => {
    onChange({ ...emptyQueryText, ...q })
    if ((['project', 'sort', 'collation', 'hint', 'skip', 'limit', 'maxTimeMS'] as const).some((k) => q[k]))
      setShowOptions(true)
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border bg-panel px-3 py-2.5" data-testid="query-bar">
      <div className="flex items-start gap-2">
        <span className="mt-[7px] w-14 shrink-0 text-xs font-semibold text-muted-foreground">Filter</span>
        <QueryEditor
          field="filter"
          value={query.filter}
          onChange={(v) => set('filter', v)}
          placeholder="{ field: 'value' }   ⌘↵ to run · ↑ history"
          handlers={handlers}
          externalError={errorFor('filter')}
          testId="filter-editor"
          namespace={namespace}
          autoFocus
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowOptions(!showOptions)}
            aria-expanded={showOptions}
            data-testid="toggle-options"
          >
            Options{' '}
            <ChevronDown size={12} className={cn('transition-transform', showOptions && 'rotate-180')} />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                aria-label="History and saved queries"
                data-testid="history-button"
              >
                <History size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[60vh] w-[480px] overflow-auto text-xs">
              {favorites.length > 0 && (
                <>
                  <DropdownMenuLabel className="text-[10px] tracking-wide text-muted-foreground uppercase">
                    Saved
                  </DropdownMenuLabel>
                  {favorites.map((f) => (
                    <DropdownMenuItem key={f.id} onSelect={() => load(f.query)} className="group text-xs">
                      <Star size={11} className="shrink-0 text-warn" />
                      <span className="shrink-0 font-medium">{f.name}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                        {summary(f.query)}
                      </span>
                      <button
                        type="button"
                        className="hidden text-muted-foreground group-hover:block hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          void ipc('favorites:delete', f.id).then(() =>
                            qc.invalidateQueries({ queryKey: ['favorites', ns] })
                          )
                        }}
                      >
                        Remove
                      </button>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuLabel className="text-[10px] tracking-wide text-muted-foreground uppercase">
                Recent
              </DropdownMenuLabel>
              {history.length === 0 && (
                <div className="px-2 py-1.5 text-muted-foreground">
                  No queries run on this collection yet.
                </div>
              )}
              {history.slice(0, 50).map((h) => (
                <DropdownMenuItem key={h.id} onSelect={() => load(h.query)} className="text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono">{summary(h.query)}</span>
                  <span className="shrink-0 text-muted-foreground">{new Date(h.ranAt).toLocaleString()}</span>
                </DropdownMenuItem>
              ))}
              {history.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      void ipc('history:clear', { connectionId, ns }).then(() =>
                        qc.invalidateQueries({ queryKey: historyKey })
                      )
                    }
                    className="text-xs text-muted-foreground"
                  >
                    Clear history
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu onOpenChange={(o) => o && void getFields(connectionId, ns).then(setSample)}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="More query actions" data-testid="query-tools">
                <MoreHorizontal size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 text-xs">
              <DropdownMenuItem
                className="text-xs"
                onSelect={() => void rewrite((field, text) => ipc('query:format', { field, text }))}
                disabled={isQueryEmpty(query)}
              >
                Format
                <span className="ml-auto text-muted-foreground">⌘⇧F</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] tracking-wide text-muted-foreground uppercase">
                Convert to
              </DropdownMenuLabel>
              <DropdownMenuItem
                className="text-xs"
                onSelect={() => convert('shell')}
                data-testid="convert-shell"
              >
                Shell syntax
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs"
                onSelect={() => convert('canonical')}
                data-testid="convert-canonical"
              >
                Canonical Extended JSON
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex-col items-start gap-0 text-xs"
                onSelect={() => convert('relaxed')}
                data-testid="convert-relaxed"
              >
                Relaxed Extended JSON
                <span className="text-[10px] text-muted-foreground">
                  Numbers become plain JSON: types may change
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-xs"
                // Opening a dialog from a menu item must wait for the menu to close.
                onSelect={() => setTimeout(() => setExporting(true))}
                data-testid="export-code-item"
              >
                <Code2 size={13} /> Export to code…
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex-col items-start gap-0 text-xs"
                onSelect={(e) => {
                  e.preventDefault()
                  setSample(null)
                  void refreshFields(connectionId, ns).then(setSample)
                }}
                data-testid="refresh-fields"
              >
                Refresh field suggestions
                <span className="text-[10px] text-muted-foreground">
                  {sample
                    ? `${sample.fields.length} fields from ${sample.sampled.toLocaleString()} sampled documents`
                    : 'Sampling…'}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            size="sm"
            variant="ghost"
            aria-label="Save query"
            onClick={() => setSaving(true)}
            disabled={isQueryEmpty(query)}
          >
            <Star size={14} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Reset"
            onClick={() => onChange(emptyQueryText)}
            disabled={isQueryEmpty(query)}
          >
            <RotateCcw size={13} />
          </Button>
          {running ? (
            <Button size="sm" variant="outline" onClick={onCancel} data-testid="cancel-query">
              <Square size={11} /> Cancel
            </Button>
          ) : (
            <Button size="sm" onClick={run} data-testid="run-query">
              <Play size={11} /> Find
            </Button>
          )}
        </div>
      </div>

      {showOptions && (
        <div className="grid grid-cols-[3.5rem_1fr] items-start gap-x-2 gap-y-2" data-testid="query-options">
          {(['project', 'sort', 'collation', 'hint'] as const).map((f) => (
            <OptionRow key={f} label={fieldLabel[f]}>
              <QueryEditor
                field={f}
                value={query[f]}
                onChange={(v) => set(f, v)}
                placeholder={
                  f === 'project'
                    ? '{ field: 0 }'
                    : f === 'sort'
                      ? '{ field: -1 }'
                      : f === 'collation'
                        ? "{ locale: 'simple' }"
                        : '{ field: -1 } or index name'
                }
                handlers={handlers}
                externalError={errorFor(f)}
                testId={`${f}-editor`}
                namespace={namespace}
              />
            </OptionRow>
          ))}
          <OptionRow label="">
            <div className="grid grid-cols-3 gap-3">
              {(['skip', 'limit', 'maxTimeMS'] as const).map((f) => (
                <label key={f} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-xs font-semibold text-muted-foreground">
                    {fieldLabel[f]}
                  </span>
                  <Input
                    className={cn('h-7 font-mono text-xs', errorFor(f) && 'border-destructive')}
                    inputMode="numeric"
                    value={query[f]}
                    placeholder={f === 'maxTimeMS' ? '60000' : '0'}
                    title={errorFor(f)?.message}
                    onChange={(e) => set(f, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') run()
                      if (e.key === 'Escape') onCancel()
                    }}
                    data-testid={`${f}-input`}
                  />
                </label>
              ))}
            </div>
          </OptionRow>
        </div>
      )}

      {toolError && (
        <div className="text-xs text-destructive" data-testid="query-tool-error">
          {toolError}
        </div>
      )}
      {exporting && (
        <ExportCodeDialog ns={ns} source={{ kind: 'query', query }} onClose={() => setExporting(false)} />
      )}
      {saving && <SaveQueryDialog ns={ns} query={query} onClose={() => setSaving(false)} />}
    </div>
  )
}

function OptionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="mt-[7px] text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="flex min-w-0">{children}</div>
    </>
  )
}

function SaveQueryDialog({ ns, query, onClose }: { ns: string; query: QueryText; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const save = async () => {
    await ipc('favorites:save', { name, ns, query })
    await qc.invalidateQueries({ queryKey: ['favorites', ns] })
    onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Save query"
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} data-testid="save-query-submit">
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        className="flex flex-col gap-3"
      >
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Recent unpaid orders"
            data-testid="save-query-name"
          />
        </Field>
        <pre className="selectable max-h-40 overflow-auto rounded bg-panel-2 p-2 font-mono text-[11px] whitespace-pre-wrap">
          {summary(query)}
        </pre>
      </form>
    </Dialog>
  )
}

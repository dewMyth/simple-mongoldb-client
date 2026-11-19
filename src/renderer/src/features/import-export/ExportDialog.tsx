/**
 * Export the current query or the whole collection to JSON (canonical/relaxed EJSON, array or
 * lines) or CSV. Streams in main; progress comes from the jobs store.
 */
import { useEffect, useMemo, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { exportFormatLabel, exportFormats, type EjsonMode, type ExportFormat } from '@shared/import-export'
import { isQueryEmpty, type QueryText } from '@shared/query'
import { cn } from '@renderer/lib/utils'
import { Dialog } from '../../components/Dialog'
import { Button } from '../../components/ui/button'
import { Checkbox } from '../../components/ui/checkbox'
import { ErrorBox } from '../../components/form'
import { ipc } from '../../lib/ipc'
import { getFields } from '../../lib/field-cache'
import { trackJob, useJobsStore } from '../../stores/jobs'
import { JobStatus } from './JobStatus'

function Choice<T extends string>({
  value,
  current,
  onChange,
  label,
  hint,
  disabled,
  testId
}: {
  value: T
  current: T
  onChange: (v: T) => void
  label: string
  hint?: string
  disabled?: boolean
  testId?: string
}) {
  return (
    <label
      className={cn('flex cursor-pointer items-start gap-2 text-sm', disabled && 'cursor-default opacity-50')}
    >
      <input
        type="radio"
        className="mt-1"
        checked={current === value}
        disabled={disabled}
        onChange={() => onChange(value)}
        data-testid={testId}
      />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  )
}

export function ExportDialog({
  connectionId,
  ns,
  query,
  onClose
}: {
  connectionId: string
  ns: string
  query: QueryText | null
  onClose: () => void
}) {
  const coll = ns.slice(ns.indexOf('.') + 1)
  const hasQuery = !!query && !isQueryEmpty(query)
  const [source, setSource] = useState<'query' | 'collection'>(hasQuery ? 'query' : 'collection')
  const [format, setFormat] = useState<ExportFormat>('json')
  const [ejson, setEjson] = useState<EjsonMode>('canonical')
  const [paths, setPaths] = useState<string[] | null>(null)
  const [fields, setFields] = useState<Set<string>>(new Set())
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const job = useJobsStore((s) => (jobId ? s.jobs[jobId] : undefined))

  // CSV columns: every non-document path from a sample (types say which are documents).
  useEffect(() => {
    if (format !== 'csv' || paths) return
    void getFields(connectionId, ns).then(({ fields: stats }) => {
      const leaves = stats.filter((f) => !f.types.every((t) => t.type === 'object')).map((f) => f.path)
      setPaths(leaves)
      setFields(
        new Set(leaves.filter((p) => !p.includes('.') || stats.find((s) => s.path === p)!.depth <= 1))
      )
    })
  }, [format, paths, connectionId, ns])

  const orderedFields = useMemo(() => (paths ?? []).filter((p) => fields.has(p)), [paths, fields])

  const start = async () => {
    setError(null)
    try {
      const ext = format === 'csv' ? 'csv' : format === 'jsonl' ? 'jsonl' : 'json'
      const file = await ipc('files:chooseExport', { defaultName: `${coll}.${ext}` })
      if (!file) return
      const p = await ipc('export:start', {
        connectionId,
        ns,
        token: file.token,
        source: source === 'query' && query ? { kind: 'query', query } : { kind: 'collection' },
        format,
        ejson,
        ...(format === 'csv' ? { fields: orderedFields } : {})
      })
      trackJob(p)
      setJobId(p.jobId)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const running = job?.status === 'running'
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Export ${ns}`}
      description="Written to disk as it’s read, so large collections are fine."
      width="md"
      footer={
        job ? (
          <>
            {running ? (
              <Button
                variant="outline"
                onClick={() => void ipc('jobs:cancel', job.jobId)}
                data-testid="export-cancel"
              >
                Cancel export
              </Button>
            ) : job.status === 'done' ? (
              <Button variant="ghost" onClick={() => void ipc('jobs:reveal', job.jobId)}>
                <FolderOpen /> Show in folder
              </Button>
            ) : null}
            <Button onClick={onClose}>{running ? 'Hide' : 'Close'}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => void start()}
              disabled={format === 'csv' && !orderedFields.length}
              data-testid="export-start"
            >
              Export…
            </Button>
          </>
        )
      }
    >
      {job ? (
        <JobStatus job={job} />
      ) : (
        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Documents</h3>
            <Choice
              value="query"
              current={source}
              onChange={setSource}
              disabled={!hasQuery}
              label="Current query"
              hint={hasQuery ? query!.filter.trim() || '{}' : 'No query in this tab'}
              testId="export-source-query"
            />
            <Choice
              value="collection"
              current={source}
              onChange={setSource}
              label="Whole collection"
              testId="export-source-collection"
            />
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Format</h3>
            {exportFormats.map((f) => (
              <Choice
                key={f}
                value={f}
                current={format}
                onChange={setFormat}
                label={exportFormatLabel[f]}
                testId={`export-format-${f}`}
              />
            ))}
          </section>
          {format !== 'csv' ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">Extended JSON</h3>
              <Choice
                value="canonical"
                current={ejson}
                onChange={setEjson}
                label="Canonical"
                hint="Keeps every type exactly (Int32, Int64, Double, Decimal128…). Recommended for re-importing."
              />
              <Choice
                value="relaxed"
                current={ejson}
                onChange={setEjson}
                label="Relaxed"
                hint="Easier to read, but numbers become plain JSON numbers: their exact types are lost."
                testId="export-ejson-relaxed"
              />
            </section>
          ) : (
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">Columns</h3>
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6"
                  onClick={() => setFields(new Set(paths ?? []))}
                >
                  All
                </Button>
                <Button size="sm" variant="ghost" className="h-6" onClick={() => setFields(new Set())}>
                  None
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Nested fields use dot notation; arrays and documents are written as JSON. CSV doesn’t keep
                BSON types.
              </p>
              <div className="max-h-52 overflow-auto rounded border p-2" data-testid="export-fields">
                {!paths && <div className="text-xs text-muted-foreground">Sampling fields…</div>}
                {paths?.map((p) => (
                  <label key={p} className="flex items-center gap-2 py-0.5 font-mono text-xs">
                    <Checkbox
                      checked={fields.has(p)}
                      onCheckedChange={(v) =>
                        setFields((s) => {
                          const n = new Set(s)
                          if (v === true) n.add(p)
                          else n.delete(p)
                          return n
                        })
                      }
                    />
                    {p}
                  </label>
                ))}
              </div>
            </section>
          )}
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
      )}
    </Dialog>
  )
}

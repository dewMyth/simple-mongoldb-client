/**
 * Import JSON (array, JSON lines or documents; EJSON-aware) or CSV (with a type per column)
 * into a collection, with a preview of the first 20 items and progress.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FileUp } from 'lucide-react'
import {
  csvColumnTypeLabel,
  csvColumnTypes,
  type ChosenFile,
  type CsvColumnType,
  type ImportPreview
} from '@shared/import-export'
import { fromBsonBytes } from '@shared/bson-wire'
import { Dialog } from '../../components/Dialog'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Spinner } from '../../components/ui/spinner'
import { CheckboxField, ErrorBox, Field } from '../../components/form'
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group'
import { ipc } from '../../lib/ipc'
import { formatBytes } from '../../lib/format'
import { trackJob, useJobsStore } from '../../stores/jobs'
import { useCan } from '../permissions/queries'
import { keys } from '../connections/queries'
import { JsonTree } from '../documents/JsonTree'
import { JobStatus } from './JobStatus'

export function ImportDialog({
  connectionId,
  ns,
  onClose
}: {
  connectionId: string
  ns: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const db = ns.slice(0, ns.indexOf('.'))
  const [file, setFile] = useState<ChosenFile | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [types, setTypes] = useState<CsvColumnType[]>([])
  const [target, setTarget] = useState(ns.slice(ns.indexOf('.') + 1))
  const [stopOnError, setStopOnError] = useState(false)
  const [ignoreEmpty, setIgnoreEmpty] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useJobsStore((s) => (jobId ? s.jobs[jobId] : undefined))
  const targetNs = `${db}.${target.trim()}`
  const canInsert = useCan(connectionId, targetNs, 'insert')
  const docs = useMemo(() => (preview?.docs ?? []).map((b) => fromBsonBytes(b)), [preview])

  const load = async (f: ChosenFile, format?: 'json' | 'csv') => {
    setBusy(true)
    setError(null)
    try {
      const p = await ipc('import:preview', { token: f.token, format })
      setPreview(p)
      setTypes(p.csv?.detected ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const choose = async () => {
    const f = await ipc('files:chooseImport').catch((e: Error) => (setError(e.message), null))
    if (!f) return
    setFile(f)
    await load(f)
  }

  const start = async () => {
    if (!file || !preview) return
    setError(null)
    try {
      const p = await ipc('import:start', {
        connectionId,
        ns: targetNs,
        token: file.token,
        format: preview.format,
        ...(preview.csv
          ? { columns: preview.csv.headers.map((name, i) => ({ name, type: types[i] ?? 'auto' })) }
          : {}),
        ignoreEmpty,
        stopOnError
      })
      trackJob(p)
      setJobId(p.jobId)
    } catch (e) {
      const err = e as Error
      if (err.name !== 'CancelledError') setError(err.message)
    }
  }

  // Once finished, refresh the collection list (a new collection may exist) and counts.
  const finished = !!job && job.status !== 'running'
  useEffect(() => {
    if (finished) void qc.invalidateQueries({ queryKey: keys.collections(connectionId, db) })
  }, [finished, qc, connectionId, db])

  const running = job?.status === 'running'
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Import into ${db}`}
      description="JSON (array, JSON lines, Extended JSON) or CSV. Inserted in batches of 1,000."
      width="lg"
      footer={
        job ? (
          <>
            {running && (
              <Button
                variant="outline"
                onClick={() => void ipc('jobs:cancel', job.jobId)}
                data-testid="import-cancel"
              >
                Cancel import
              </Button>
            )}
            <Button onClick={onClose}>{running ? 'Hide' : 'Close'}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => void start()}
              disabled={
                !preview ||
                !target.trim() ||
                !canInsert.allowed ||
                (preview.errors.length > 0 && !docs.length && !preview.csv)
              }
              title={canInsert.allowed ? undefined : `Import: ${canInsert.reason}`}
              data-testid="import-start"
            >
              Import
            </Button>
          </>
        )
      }
    >
      {job ? (
        <JobStatus job={job} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => void choose()} data-testid="import-choose">
              <FileUp /> {file ? 'Choose another file…' : 'Choose file…'}
            </Button>
            {file && (
              <span className="text-sm" data-testid="import-file">
                {file.name} <span className="text-muted-foreground">· {formatBytes(file.size)}</span>
              </span>
            )}
            {busy && <Spinner className="size-3.5" />}
            {preview && (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                className="ml-auto"
                value={preview.format}
                onValueChange={(v) => v && file && void load(file, v as 'json' | 'csv')}
              >
                <ToggleGroupItem value="json" className="px-2.5 text-xs">
                  JSON
                </ToggleGroupItem>
                <ToggleGroupItem value="csv" className="px-2.5 text-xs" data-testid="import-format-csv">
                  CSV
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>

          {preview && (
            <>
              {preview.errors.length > 0 && <ErrorBox>{preview.errors.slice(0, 5).join(' · ')}</ErrorBox>}
              {preview.csv ? (
                <div className="max-h-72 overflow-auto rounded border" data-testid="import-preview">
                  <table className="w-full border-collapse text-xs">
                    <thead className="sticky top-0 bg-panel">
                      <tr>
                        {preview.csv.headers.map((h, i) => (
                          <th key={i} className="border-b px-2 py-1 text-left align-top font-medium">
                            <div className="font-mono">{h}</div>
                            <select
                              aria-label={`Type of ${h}`}
                              value={types[i] ?? 'auto'}
                              onChange={(e) =>
                                setTypes((t) =>
                                  t.map((x, j) => (j === i ? (e.target.value as CsvColumnType) : x))
                                )
                              }
                              className="mt-1 h-6 rounded border border-input bg-background px-1 text-[11px] font-normal"
                              data-testid={`import-type-${h}`}
                            >
                              {csvColumnTypes.map((t) => (
                                <option key={t} value={t}>
                                  {csvColumnTypeLabel[t]}
                                </option>
                              ))}
                            </select>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.csv.rows.map((r, ri) => (
                        <tr key={ri} className="border-b">
                          {preview.csv!.headers.map((_, ci) => (
                            <td key={ci} className="max-w-48 truncate px-2 py-1 font-mono" title={r[ci]}>
                              {r[ci]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex max-h-72 flex-col gap-1.5 overflow-auto" data-testid="import-preview">
                  {docs.map((d, i) => (
                    <div key={i} className="rounded border bg-card">
                      <JsonTree doc={d} epoch={0} mode="default" />
                    </div>
                  ))}
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Showing the first {preview.csv ? preview.csv.rows.length : docs.length} items.
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label={`Collection in ${db}`}>
                  <Input
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    data-testid="import-target"
                  />
                </Field>
                <div className="flex flex-col gap-2 pt-5">
                  <CheckboxField
                    checked={stopOnError}
                    onChange={setStopOnError}
                    label="Stop on the first error (otherwise skip bad documents)"
                  />
                  {preview.csv && (
                    <CheckboxField
                      checked={!ignoreEmpty}
                      onChange={(v) => setIgnoreEmpty(!v)}
                      label="Import empty cells as empty strings"
                    />
                  )}
                </div>
              </div>
            </>
          )}
          {error && <ErrorBox>{error}</ErrorBox>}
        </div>
      )}
    </Dialog>
  )
}

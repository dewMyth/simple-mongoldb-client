import { useQuery } from '@tanstack/react-query'
import { FolderOpen, X } from 'lucide-react'
import { useJobsStore } from '../stores/jobs'
import { jobFraction, jobSummary } from '../features/import-export/job-format'
import { Spinner } from '../components/ui/spinner'
import { ipc } from '../lib/ipc'
import { focusedTabId, useTabsStore } from '../stores/tabs'
import { useActiveConnections, useSavedConnections } from '../features/connections/queries'

export function StatusBar() {
  const { data } = useQuery({ queryKey: ['app-info'], queryFn: () => ipc('app:info') })
  const { data: active = [] } = useActiveConnections()
  const { data: saved = [] } = useSavedConnections()
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === focusedTabId(s)))
  const current = tab ? active.find((a) => a.id === tab.connectionId) : undefined
  const conn = tab ? saved.find((c) => c.id === tab.connectionId) : undefined

  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between gap-4 border-t border-border bg-panel px-3 text-[11px] text-muted-foreground"
      data-testid="status-bar"
    >
      <span className="truncate">
        {current && conn
          ? `${conn.name} · MongoDB ${current.server.version} · ${current.server.topology} · ${current.server.latencyMs} ms`
          : active.length
            ? `${active.length} connection${active.length > 1 ? 's' : ''} open`
            : 'Not connected'}
      </span>
      <span className="flex items-center gap-3">
        <JobsIndicator />
        <span>{data ? `v${data.version}` : ''}</span>
      </span>
    </footer>
  )
}

/** Running and recently finished imports/exports (dismissable). */
function JobsIndicator() {
  // Select the stable map; Object.values in the selector would re-render forever.
  const jobMap = useJobsStore((s) => s.jobs)
  const jobs = Object.values(jobMap)
  const dismiss = useJobsStore((s) => s.dismiss)
  if (!jobs.length) return null
  return (
    <span className="flex items-center gap-3" data-testid="status-jobs">
      {jobs.slice(-3).map((j) => {
        const f = jobFraction(j)
        return (
          <span key={j.jobId} className="flex items-center gap-1.5" title={jobSummary(j)}>
            {j.status === 'running' && <Spinner className="size-3" />}
            <span className={j.status === 'error' ? 'text-destructive' : undefined}>
              {j.kind === 'export' ? 'Export' : 'Import'} {j.file}
              {j.status === 'running'
                ? f === null
                  ? '…'
                  : ` ${Math.round(f * 100)}%`
                : ` · ${j.status === 'done' ? 'done' : j.status}`}
            </span>
            {j.status === 'running' ? (
              <button
                type="button"
                aria-label="Cancel"
                className="hover:text-foreground"
                onClick={() => void ipc('jobs:cancel', j.jobId)}
              >
                <X size={11} />
              </button>
            ) : (
              <>
                {j.kind === 'export' && j.status === 'done' && (
                  <button
                    type="button"
                    aria-label="Show in folder"
                    className="hover:text-foreground"
                    onClick={() => void ipc('jobs:reveal', j.jobId)}
                  >
                    <FolderOpen size={11} />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="hover:text-foreground"
                  onClick={() => dismiss(j.jobId)}
                >
                  <X size={11} />
                </button>
              </>
            )}
          </span>
        )
      })}
    </span>
  )
}

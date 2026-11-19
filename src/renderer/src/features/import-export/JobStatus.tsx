import type { JobProgress } from '@shared/import-export'
import { jobFraction, jobSummary } from './job-format'
import { Spinner } from '../../components/ui/spinner'

export function JobStatus({ job }: { job: JobProgress }) {
  const fraction = jobFraction(job)
  return (
    <div className="flex flex-col gap-3" data-testid="job-status" data-status={job.status}>
      <div className="flex items-center gap-2 text-sm">
        {job.status === 'running' && <Spinner className="size-3.5" />}
        <span className={job.status === 'error' ? 'text-destructive' : undefined} data-testid="job-summary">
          {jobSummary(job)}
        </span>
      </div>
      {job.status === 'running' && (
        <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: fraction === null ? '30%' : `${Math.round(fraction * 100)}%` }}
          />
        </div>
      )}
      {job.errors.length > 0 && (
        <div
          className="max-h-40 overflow-auto rounded border bg-panel-2 p-2 font-mono text-[11px]"
          data-testid="job-errors"
        >
          {job.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
          {job.failed > job.errors.length && (
            <div className="text-muted-foreground">
              …and {(job.failed - job.errors.length).toLocaleString()} more
            </div>
          )}
        </div>
      )}
    </div>
  )
}

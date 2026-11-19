import type { JobProgress } from '@shared/import-export'
import { formatBytes } from '../../lib/format'

/** Fraction done, from documents (export with a known total) or bytes read (import). */
export function jobFraction(job: JobProgress): number | null {
  if (job.status === 'done') return 1
  if (job.kind === 'export' && job.total) return Math.min(1, job.processed / job.total)
  if (job.kind === 'import' && job.totalBytes) return Math.min(1, job.bytes / job.totalBytes)
  return null
}

export function jobSummary(job: JobProgress): string {
  const verb = job.kind === 'export' ? 'Exported' : 'Imported'
  if (job.status === 'running')
    return job.kind === 'export'
      ? `Exporting ${job.processed.toLocaleString()}${job.total ? ` of ${job.total.toLocaleString()}` : ''} documents…`
      : `Importing… ${job.inserted.toLocaleString()} inserted${job.failed ? `, ${job.failed.toLocaleString()} failed` : ''}`
  if (job.status === 'cancelled')
    return job.kind === 'export'
      ? 'Export cancelled (the partial file was removed).'
      : `Import cancelled after ${job.inserted.toLocaleString()} documents.`
  if (job.status === 'error')
    return `${job.kind === 'export' ? 'Export' : 'Import'} failed: ${job.message ?? ''}`
  return job.kind === 'export'
    ? `${verb} ${job.processed.toLocaleString()} documents to ${job.file} (${formatBytes(job.bytes)}).`
    : `${verb} ${job.inserted.toLocaleString()} documents${job.failed ? `; ${job.failed.toLocaleString()} failed` : ''}.`
}

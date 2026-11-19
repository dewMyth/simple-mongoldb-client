/** Import/export jobs, kept up to date by main's `jobs:progress` events. */
import { useEffect } from 'react'
import { create } from 'zustand'
import type { JobProgress } from '@shared/import-export'

interface JobsState {
  jobs: Record<string, JobProgress>
  dismiss: (jobId: string) => void
}

export const useJobsStore = create<JobsState>((set, get) => ({
  jobs: {},
  dismiss(jobId) {
    const jobs = { ...get().jobs }
    delete jobs[jobId]
    set({ jobs })
  }
}))

/** Call once (App): listens for progress events. */
export function useJobEvents(): void {
  useEffect(
    () =>
      window.api.on('jobs:progress', (p) =>
        useJobsStore.setState((s) => ({ jobs: { ...s.jobs, [p.jobId]: p } }))
      ),
    []
  )
}

/** Records the job returned by export:start / import:start before its first event arrives. */
export function trackJob(p: JobProgress): void {
  useJobsStore.setState((s) => ({ jobs: { ...s.jobs, [p.jobId]: s.jobs[p.jobId] ?? p } }))
}

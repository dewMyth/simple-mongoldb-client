/**
 * Per-stage previews for the aggregation builder. Debounced while typing (auto-preview) or on
 * demand; each new request cancels the previous one on the server ("<tabId>#preview").
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  isWriteStage,
  textToStages,
  type PipelineState,
  type StageInput,
  type StagePreview
} from '@shared/pipeline'
import { ipc } from '../../lib/ipc'

const DEBOUNCE_MS = 500

export interface PreviewRequest {
  stages: StageInput[]
  /** Stage-mode card id for each entry of `stages`. */
  ids: string[]
  lastOnly: boolean
  /** Text mode: the pipeline ends with $out/$merge (preview shows the output before it). */
  endsWithWrite: boolean
}

export type BuiltRequest = { ok: true; request: PreviewRequest } | { ok: false; error: string; line?: number }

/** The enabled stages to send, from either mode. */
export function buildRequest(state: PipelineState): BuiltRequest {
  if (state.mode === 'text') {
    const r = textToStages(state.text)
    if (!r.ok) return { ok: false, error: r.error, line: r.line }
    const enabled = r.stages.filter((s) => s.enabled)
    const firstWrite = enabled.findIndex((s) => isWriteStage(s.operator))
    const runnable = firstWrite >= 0 ? enabled.slice(0, firstWrite) : enabled
    return {
      ok: true,
      request: {
        stages: runnable.map(({ operator, body }) => ({ operator, body })),
        ids: [],
        lastOnly: true,
        endsWithWrite: firstWrite >= 0
      }
    }
  }
  const enabled = state.stages.filter((s) => s.enabled)
  return {
    ok: true,
    request: {
      stages: enabled.map(({ operator, body }) => ({ operator, body })),
      ids: enabled.map((s) => s.id),
      lastOnly: false,
      endsWithWrite: false
    }
  }
}

export interface Previews {
  byId: Record<string, StagePreview>
  /** The pipeline's final output (text mode), or null. */
  last: StagePreview | null
  /** Text mode: the first stage error, which blocks the output. */
  firstError: StagePreview | null
  loading: boolean
  /** Results are from an older version of the pipeline (auto-preview off). */
  stale: boolean
  error: string | null
  refresh: () => void
}

export function usePreviews(
  target: { tabId: string; connectionId: string; ns: string },
  state: PipelineState
): Previews {
  const built = useMemo(() => buildRequest(state), [state])
  const key = JSON.stringify([built, state.sampleSize, state.options])
  const [manual, setManual] = useState(0)
  const [result, setResult] = useState<{
    key: string
    previews: StagePreview[]
    request: PreviewRequest
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)
  const lastManual = useRef(0)

  useEffect(() => {
    const manualRun = manual !== lastManual.current
    lastManual.current = manual
    if (!state.autoPreview && !manualRun) return
    if (!built.ok || !built.request.stages.length) return
    const seq = ++latest.current
    const request = built.request
    const t = setTimeout(
      () => {
        setLoading(true)
        const owner = `${target.tabId}#preview`
        void ipc('ops:cancelForTab', owner)
          .catch(() => 0)
          .then(() =>
            ipc('agg:preview', {
              connectionId: target.connectionId,
              ns: target.ns,
              tabId: owner,
              stages: request.stages,
              sampleSize: state.sampleSize,
              options: state.options,
              lastOnly: request.lastOnly
            })
          )
          .then((previews) => {
            if (seq !== latest.current) return
            setResult({ key, previews, request })
            setError(null)
          })
          .catch((e: Error) => {
            if (seq !== latest.current || e.name === 'CancelledError') return
            setError(e.message)
          })
          .finally(() => seq === latest.current && setLoading(false))
      },
      manualRun ? 0 : DEBOUNCE_MS
    )
    return () => clearTimeout(t)
    // `key` captures every input of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, manual, state.autoPreview, target.tabId, target.connectionId, target.ns])

  return useMemo(() => {
    const byId: Record<string, StagePreview> = {}
    let last: StagePreview | null = null
    let firstError: StagePreview | null = null
    if (result) {
      result.request.ids.forEach((id, i) => {
        const p = result.previews[i]
        if (p) byId[id] = p
      })
      last = result.previews.at(-1) ?? null
      firstError = result.previews.find((p) => p.status === 'error') ?? null
    }
    return {
      byId,
      last,
      firstError,
      loading,
      stale: !!result && result.key !== key,
      error: built.ok ? error : built.error,
      refresh: () => setManual((n) => n + 1)
    }
  }, [result, loading, key, error, built])
}

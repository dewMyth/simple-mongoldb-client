import { handle } from './router'
import { aggregations, permissions, pipelineLibrary } from '../services'
import { buildPipeline, writeTarget } from '../services/aggregation-service'
import { isUnauthorized } from '../services/permission-service'
import { splitNamespace } from '../services/query-service'
import type { StageInput } from '@shared/pipeline'

/** Reads aren't pre-blocked, but an Unauthorized result is remembered (like find). */
async function learnRead<T>(connectionId: string, ns: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isUnauthorized(err)) permissions.recordDenied(connectionId, ns, 'find', err)
    throw err
  }
}

/** Where the pipeline writes ($out/$merge as the last stage), if anywhere. */
function targetOf(ns: string, stages: StageInput[]): string | null {
  const built = buildPipeline(stages)
  const last = built.ok ? built.pipeline.at(-1) : undefined
  return last ? writeTarget(last, splitNamespace(ns).db) : null
}

export function registerAggregationHandlers(): void {
  handle('agg:preview', (input) => learnRead(input.connectionId, input.ns, () => aggregations.preview(input)))
  handle('agg:run', (input) => {
    const target = targetOf(input.ns, input.stages)
    if (!target) return learnRead(input.connectionId, input.ns, () => aggregations.run(input))
    // $out replaces the target collection, so it needs remove as well as insert.
    if (input.stages.at(-1)?.operator === '$out') permissions.assert(input.connectionId, target, 'remove')
    return permissions.guard(input.connectionId, target, 'insert', () => aggregations.run(input))
  })
  handle('agg:createView', (input) =>
    permissions.guard(input.connectionId, splitNamespace(input.ns).db, 'createCollection', () =>
      aggregations.createView(input)
    )
  )
  handle('agg:exportCode', (input) => aggregations.exportCode(input))
  handle('agg:validateStage', (stage) => {
    const built = buildPipeline([stage])
    if (built.ok) return null
    const e = built.errors[0]!
    return { field: 'filter', message: e.message, line: e.line, column: e.column }
  })
  handle('pipelines:list', (ns) => pipelineLibrary.list(ns))
  handle('pipelines:save', (input) => pipelineLibrary.save(input))
  handle('pipelines:delete', (id) => pipelineLibrary.delete(id))
}

import { newPipelineState } from '@shared/pipeline'
import { useTabsStore } from '../../stores/tabs'

/** Opens (or switches to) the aggregation tab for a collection, seeding $match with a filter. */
export function openAggregation(connectionId: string, ns: string, filter?: string): string {
  const pipeline = newPipelineState()
  if (filter?.trim()) pipeline.stages[0]!.body = filter.trim()
  return useTabsStore.getState().open({
    type: 'aggregation',
    connectionId,
    ns,
    title: `${ns.slice(ns.indexOf('.') + 1)} · aggregate`,
    pipeline
  })
}

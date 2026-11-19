/**
 * Schema tab: analyses a sample of the collection (optionally filtered) and shows each field's
 * presence, its BSON types with their share, and a chart per type. Clicking a value or bar adds
 * it to the filter (again removes it), as in Compass; "Analyze" re-runs on the filtered sample.
 */
import { memo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Play, Table2 } from 'lucide-react'
import { bsonTypeLabel } from '@shared/bson-types'
import { emptyQueryText } from '@shared/query'
import type { SchemaChart, SchemaFieldInfo, SchemaTypeInfo } from '@shared/schema'
import { cn } from '@renderer/lib/utils'
import { useTabsStore, type Tab } from '../../stores/tabs'
import { currentSettings } from '../../stores/settings'
import { ipc } from '../../lib/ipc'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Spinner } from '../../components/ui/spinner'
import { ErrorBox } from '../../components/form'
import { QueryEditor } from '../query-bar/QueryEditor'
import { typeFill } from './colors'

const pct = (p: number) =>
  `${p >= 0.995 || p === 0 ? Math.round(p * 100) : (p * 100).toFixed(p < 0.1 ? 1 : 0)}%`

export function SchemaTab({ tab }: { tab: Tab }) {
  const setQuery = useTabsStore((s) => s.setQuery)
  const patch = useTabsStore((s) => s.patch)
  const ns = tab.ns!
  const filter = tab.query.filter
  const [sampleSize, setSampleSize] = useState(() => currentSettings().sampleSize)
  // What was analysed (the filter as it was when Analyze was pressed).
  const [request, setRequest] = useState<{ filter: string; sampleSize: number; n: number } | null>(
    tab.autoRun ? { filter, sampleSize: currentSettings().sampleSize, n: 0 } : null
  )
  const q = useQuery({
    queryKey: ['schema', tab.id, request],
    queryFn: () =>
      ipc('schema:analyze', {
        connectionId: tab.connectionId,
        ns,
        tabId: tab.id,
        sampleSize: request!.sampleSize,
        filter: request!.filter
      }),
    enabled: !!request,
    retry: false,
    staleTime: Infinity,
    gcTime: 5 * 60_000
  })
  const analyze = () => {
    patch(tab.id, { autoRun: true })
    setRequest((r) => ({
      filter: useTabsStore.getState().tabs.find((t) => t.id === tab.id)?.query.filter ?? filter,
      sampleSize,
      n: (r?.n ?? 0) + 1
    }))
  }
  const setFilter = (text: string) => setQuery(tab.id, { ...tab.query, filter: text })

  const toggleValue = async (path: string, valueText: string) => {
    const current = useTabsStore.getState().tabs.find((t) => t.id === tab.id)?.query.filter ?? ''
    const next = await ipc('query:setFilterField', { filter: current, path, valueText })
    if (next !== null) setFilter(next)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="schema-tab">
      <div className="flex flex-col gap-2 border-b bg-panel px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="mt-[7px] w-14 shrink-0 text-xs font-semibold text-muted-foreground">Filter</span>
          <QueryEditor
            field="filter"
            value={filter}
            onChange={setFilter}
            placeholder="{ field: 'value' }   click chart values to add them"
            handlers={{ onRun: analyze }}
            testId="schema-filter"
            namespace={{ connectionId: tab.connectionId, ns }}
          />
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            Sample
            <Input
              className="h-7 w-20 font-mono text-xs"
              inputMode="numeric"
              value={String(sampleSize)}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isInteger(n) && n >= 1 && n <= 100_000) setSampleSize(n)
              }}
              data-testid="schema-sample-size"
            />
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              useTabsStore.getState().open({
                type: 'documents',
                connectionId: tab.connectionId,
                ns,
                title: ns.slice(ns.indexOf('.') + 1),
                query: { ...emptyQueryText, filter }
              })
            }
            title="Open these documents in a documents tab"
          >
            <Table2 /> Documents
          </Button>
          <Button size="sm" onClick={analyze} disabled={q.isFetching} data-testid="schema-analyze">
            {q.isFetching ? <Spinner className="size-3" /> : <Play size={11} />} Analyze
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!request && (
          <div className="py-10 text-center text-xs text-muted-foreground">
            Press Analyze to sample the collection.
          </div>
        )}
        {q.error && <ErrorBox error={q.error}>{(q.error as Error).message}</ErrorBox>}
        {q.isFetching && !q.data && (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Spinner className="size-3" /> Sampling {request?.sampleSize.toLocaleString()} documents…
          </div>
        )}
        {q.data && (
          <div className={cn('flex flex-col gap-2', q.isFetching && 'opacity-60')}>
            <div className="text-xs text-muted-foreground" data-testid="schema-summary">
              Analyzed {q.data.sampled.toLocaleString()} documents
              {request?.filter.trim() ? ' matching the filter' : ''} in {q.data.ms} ms ·{' '}
              {q.data.fields.length} top-level fields
            </div>
            {q.data.sampled === 0 && (
              <div className="text-xs text-muted-foreground">No documents to analyse.</div>
            )}
            {q.data.fields.map((f) => (
              <FieldCard key={f.path} field={f} onValue={toggleValue} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const FieldCard = memo(function FieldCard({
  field,
  onValue
}: {
  field: SchemaFieldInfo
  onValue: (path: string, valueText: string) => void
}) {
  const [open, setOpen] = useState(false)
  const charted = field.types.find((t) => t.chart)
  const [selected, setSelected] = useState<SchemaTypeInfo | undefined>(charted)
  const current = field.types.find((t) => t.type === selected?.type) ?? charted
  return (
    <div className="rounded-md border bg-card" data-testid={`schema-field-${field.path}`}>
      <div className="grid grid-cols-[minmax(10rem,16rem)_minmax(0,1fr)] gap-4 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            {field.children.length > 0 ? (
              <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-label={open ? 'Collapse' : 'Expand'}
                className="text-muted-foreground"
              >
                <ChevronRight size={13} className={cn('transition-transform', open && 'rotate-90')} />
              </button>
            ) : (
              <span className="w-[13px]" />
            )}
            <span className="truncate font-mono text-sm font-medium" title={field.path}>
              {field.name}
            </span>
          </div>
          <div className="mt-1 pl-4 text-[11px] text-muted-foreground" data-testid="schema-presence">
            in {pct(field.probability)} of documents
          </div>
          {/* Stacked bar of type shares. */}
          <div className="mt-2 ml-4 flex h-2 overflow-hidden rounded bg-muted">
            {field.types.map((t) => (
              <div
                key={t.type}
                style={{ width: `${t.probability * 100}%`, background: typeFill[t.type] }}
                title={`${bsonTypeLabel[t.type]} ${pct(t.probability)}`}
              />
            ))}
          </div>
          <div className="mt-1.5 ml-4 flex flex-wrap gap-1" data-testid="schema-types">
            {field.types.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => setSelected(t)}
                className={cn(
                  'flex items-center gap-1 rounded border px-1.5 py-px text-[10px]',
                  current?.type === t.type
                    ? 'border-ring bg-accent'
                    : 'border-transparent hover:border-border'
                )}
                data-type={t.type}
              >
                <span className="size-1.5 rounded-full" style={{ background: typeFill[t.type] }} />
                {bsonTypeLabel[t.type]} <span className="text-muted-foreground">{pct(t.probability)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          {current?.chart ? (
            <Chart
              chart={current.chart}
              color={typeFill[current.type]}
              onValue={(v) => onValue(field.path, v)}
            />
          ) : current?.type === 'array' ? (
            <div className="text-xs text-muted-foreground">
              Arrays, average length {current.averageLength?.toFixed(1) ?? '?'}
              {field.children.length ? ' · expand to see the fields of their documents' : ''}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {current ? `${bsonTypeLabel[current.type]} values aren’t charted.` : ''}
            </div>
          )}
        </div>
      </div>
      {open && field.children.length > 0 && (
        <div className="flex flex-col gap-2 border-t bg-panel/40 p-2 pl-6">
          {field.children.map((c) => (
            <FieldCard key={c.path} field={c} onValue={onValue} />
          ))}
        </div>
      )}
    </div>
  )
})

function Chart({
  chart,
  color,
  onValue
}: {
  chart: SchemaChart
  color: string
  onValue: (valueText: string) => void
}) {
  if (chart.kind === 'top') {
    const max = Math.max(1, ...chart.values.map((v) => v.count))
    return (
      <div className="flex flex-col gap-0.5" data-testid="schema-top-values">
        {chart.values.map((v) => (
          <button
            key={v.valueText}
            type="button"
            onClick={() => onValue(v.valueText)}
            className="group grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_3rem] items-center gap-2 rounded px-1 text-left text-[11px] hover:bg-accent"
            title={`Filter on ${v.valueText}`}
            data-value={v.valueText}
          >
            <span className="truncate font-mono">{v.label}</span>
            <span
              className="h-2.5 rounded-sm"
              style={{ width: `${(v.count / max) * 100}%`, background: color, opacity: 0.8 }}
            />
            <span className="text-right text-muted-foreground tabular-nums">{v.count}</span>
          </button>
        ))}
        {chart.distinct > chart.values.length && (
          <div className="px-1 text-[10px] text-muted-foreground">
            {chart.distinct.toLocaleString()} distinct values in the sample; showing the most common
          </div>
        )}
      </div>
    )
  }
  const max = Math.max(1, ...chart.bins.map((b) => b.count))
  return (
    <div data-testid="schema-histogram">
      <div className="flex h-20 items-end gap-px">
        {chart.bins.map((b, i) => (
          <button
            key={i}
            type="button"
            className="min-w-0 flex-1 rounded-t-sm opacity-80 hover:opacity-100"
            style={{ height: `${Math.max(2, (b.count / max) * 100)}%`, background: color }}
            title={`${b.loLabel} – ${b.hiLabel}: ${b.count}`}
            onClick={() =>
              onValue(`{ $gte: ${b.loText}, ${i === chart.bins.length - 1 ? '$lte' : '$lt'}: ${b.hiText} }`)
            }
            data-bin={i}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{chart.min}</span>
        <span>{chart.max}</span>
      </div>
    </div>
  )
}

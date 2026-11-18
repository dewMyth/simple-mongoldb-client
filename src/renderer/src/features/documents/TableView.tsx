/**
 * Table of the current page. Columns are the top-level fields of a $sample of the collection
 * (so they stay stable across pages), plus any extra fields present on this page.
 * Nested objects/arrays render as "{ n fields }" / "[ n items ]" and open as a tree in a popover.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Document } from 'bson'
import { useQuery } from '@tanstack/react-query'
import {
  bsonTypeLabel,
  bsonTypeOf,
  describeValue,
  displayScalarPreview,
  isContainer
} from '@shared/bson-types'
import type { FieldStat } from '@shared/field-stats'
import { cn } from '@renderer/lib/utils'
import { ipc } from '../../lib/ipc'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import { typeColor } from './bson-style'
import { JsonTree } from './JsonTree'

const DEFAULT_WIDTH = 180
const MIN_WIDTH = 60
const MAX_CELL_TEXT = 500

function useFieldSample(connectionId: string, ns: string, tabId: string) {
  return useQuery({
    queryKey: ['fields', connectionId, ns],
    queryFn: () => ipc('schema:sampleFields', { connectionId, ns, tabId, size: 200 }),
    staleTime: 5 * 60_000
  })
}

interface Column {
  path: string
  stat?: FieldStat
}

function columnsFor(docs: Document[], sampled: FieldStat[] | undefined): Column[] {
  const cols: Column[] = []
  const seen = new Set<string>()
  const add = (path: string, stat?: FieldStat) => {
    if (seen.has(path)) return
    seen.add(path)
    cols.push({ path, stat })
  }
  add(
    '_id',
    sampled?.find((f) => f.path === '_id')
  )
  for (const f of sampled ?? []) if (f.depth === 0) add(f.path, f)
  for (const d of docs) for (const k of Object.keys(d)) add(k)
  return cols
}

function typeSummary(stat?: FieldStat): string {
  if (!stat?.types.length) return ''
  if (stat.types.length === 1) return bsonTypeLabel[stat.types[0]!.type]
  return 'Mixed'
}

export function TableView({
  docs,
  offset,
  connectionId,
  ns,
  tabId
}: {
  docs: Document[]
  offset: number
  connectionId: string
  ns: string
  tabId: string
}) {
  const { data: sample } = useFieldSample(connectionId, ns, tabId)
  const columns = useMemo(() => columnsFor(docs, sample?.fields), [docs, sample])
  const [widths, setWidths] = useState<Record<string, number>>({ _id: 230 })
  const drag = useRef<{ path: string; startX: number; startW: number } | null>(null)

  const width = (p: string) => widths[p] ?? DEFAULT_WIDTH
  const onResizeStart = (e: ReactPointerEvent, path: string) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { path, startX: e.clientX, startW: width(path) }
  }
  const onResizeMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    setWidths((w) => ({ ...w, [d.path]: Math.max(MIN_WIDTH, d.startW + e.clientX - d.startX) }))
  }
  const onResizeEnd = () => {
    drag.current = null
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="table-view">
      <table
        className="border-separate border-spacing-0 font-mono text-[12px]"
        style={{ tableLayout: 'fixed' }}
      >
        <colgroup>
          <col style={{ width: 52 }} />
          {columns.map((c) => (
            <col key={c.path} style={{ width: width(c.path) }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-20">
          <tr>
            <th className="sticky left-0 z-30 border-r border-b bg-panel px-2 py-1.5 text-right font-sans text-[11px] font-medium text-muted-foreground">
              #
            </th>
            {columns.map((c) => (
              <th
                key={c.path}
                className="relative border-r border-b bg-panel px-2 py-1 text-left font-sans font-medium"
                data-testid={`col-${c.path}`}
              >
                <div className="truncate text-[12px] text-foreground" title={c.path}>
                  {c.path}
                </div>
                <div
                  className="truncate text-[10px] font-normal text-muted-foreground"
                  title={c.stat?.types.map((t) => `${bsonTypeLabel[t.type]}: ${t.count}`).join(', ')}
                >
                  {typeSummary(c.stat)}
                  {c.stat && c.stat.probability < 1 ? ` · ${Math.round(c.stat.probability * 100)}%` : ''}
                </div>
                <span
                  role="separator"
                  aria-label={`Resize ${c.path}`}
                  className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                  onPointerDown={(e) => onResizeStart(e, c.path)}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeEnd}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {docs.map((doc, i) => (
            <tr key={i} className="group/row" data-testid="table-row">
              <td className="sticky left-0 z-10 border-r border-b bg-panel px-2 py-1 text-right font-sans text-[11px] text-muted-foreground tabular-nums group-hover/row:bg-panel-2">
                {offset + i + 1}
              </td>
              {columns.map((c) => (
                <td
                  key={c.path}
                  className="border-r border-b bg-background px-2 py-1 group-hover/row:bg-accent/50"
                  data-field={c.path}
                >
                  <Cell value={doc[c.path]} present={Object.prototype.hasOwnProperty.call(doc, c.path)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Cell({ value, present }: { value: unknown; present: boolean }) {
  if (!present) return <span className="text-muted-foreground/40 select-none">—</span>
  const tag = bsonTypeOf(value)
  if (isContainer(tag)) {
    const n = tag === 'array' ? (value as unknown[]).length : Object.keys(value as object).length
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="truncate text-json-punct hover:text-foreground hover:underline"
            data-type={tag}
          >
            {tag === 'array' ? `[ ${n} item${n === 1 ? '' : 's'} ]` : `{ ${n} field${n === 1 ? '' : 's'} }`}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-[60vh] w-[480px] overflow-auto p-0">
          <JsonTree doc={value as Document} epoch={0} mode="default" />
        </PopoverContent>
      </Popover>
    )
  }
  const { text, truncated } = displayScalarPreview(value, tag, MAX_CELL_TEXT)
  return (
    <div
      className={cn('selectable truncate', typeColor[tag])}
      title={`${text}${truncated ? '…' : ''}\n${describeValue(value, tag)}`}
      data-type={tag}
    >
      {text}
    </div>
  )
}

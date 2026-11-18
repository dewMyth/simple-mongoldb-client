/**
 * Collapsible JSON tree for one document, with a colour per BSON type.
 *
 * Expansion state lives in a WeakMap keyed by the document object, so it survives the row being
 * virtualized away and back, and is dropped automatically when results are replaced.
 */
import { memo, useState, type ReactNode } from 'react'
import type { Document } from 'bson'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Route } from 'lucide-react'
import {
  bsonTypeLabel,
  bsonTypeOf,
  describeValue,
  displayScalar,
  isContainer,
  type BsonTypeTag
} from '@shared/bson-types'
import { toShellString } from '@shared/shell-format'
import { cn } from '@renderer/lib/utils'
import { copyText, typeColor } from './bson-style'
import { CopyMenu } from './JsonView'
import { Button } from '../../components/ui/button'

/** Children rendered per container before a "show more" control. */
const PAGE = 50
/** Strings longer than this are truncated with an expand control. */
const MAX_STRING = 300

export type ExpandMode = 'default' | 'all'

interface ExpansionState {
  /** Global expand/collapse requests bump the epoch; stale per-node overrides are then dropped. */
  epoch: number
  mode: ExpandMode
  overrides: Map<string, boolean>
}

const expansion = new WeakMap<Document, ExpansionState>()

function stateFor(doc: Document, epoch: number, mode: ExpandMode): ExpansionState {
  let s = expansion.get(doc)
  if (!s || s.epoch !== epoch) {
    s = { epoch, mode, overrides: new Map() }
    expansion.set(doc, s)
  }
  return s
}

function setOverride(doc: Document, path: string, expanded: boolean) {
  expansion.get(doc)?.overrides.set(path, expanded)
}

function setDocMode(doc: Document, mode: ExpandMode) {
  const s = expansion.get(doc)
  if (!s) return
  s.mode = mode
  s.overrides.clear()
}

function childEntries(value: unknown): [string, unknown][] {
  return Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>)
}

export const JsonTree = memo(function JsonTree({
  doc,
  epoch,
  mode
}: {
  doc: Document
  /** Changes when the user presses the global Expand all / Collapse all. */
  epoch: number
  mode: ExpandMode
}) {
  const state = stateFor(doc, epoch, mode)
  // Local counter just to re-render after mutating the (non-reactive) WeakMap state.
  const [, setTick] = useState(0)
  const rerender = () => setTick((t) => t + 1)

  const isExpanded = (path: string) => state.overrides.get(path) ?? state.mode === 'all'
  const toggle = (path: string) => {
    setOverride(doc, path, !isExpanded(path))
    rerender()
  }
  const setAll = (m: ExpandMode) => {
    setDocMode(doc, m)
    rerender()
  }

  return (
    <div
      className="group/doc relative rounded-md border bg-card py-1.5 font-mono text-[12px] leading-5"
      data-testid="json-tree"
    >
      <div className="absolute top-1 right-1 z-10 flex gap-0.5 opacity-0 transition-opacity group-hover/doc:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={state.mode === 'all' ? 'Collapse all' : 'Expand all'}
          title={state.mode === 'all' ? 'Collapse all' : 'Expand all'}
          onClick={() => setAll(state.mode === 'all' ? 'default' : 'all')}
          data-testid="doc-expand-all"
        >
          {state.mode === 'all' ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </Button>
        <CopyMenu doc={doc} />
      </div>
      {childEntries(doc).map(([k, v]) => (
        <Node
          key={k}
          name={k}
          value={v}
          path={k}
          depth={0}
          isIndex={false}
          isExpanded={isExpanded}
          toggle={toggle}
        />
      ))}
    </div>
  )
})

function Node({
  name,
  value,
  path,
  depth,
  isIndex,
  isExpanded,
  toggle
}: {
  name: string
  value: unknown
  path: string
  depth: number
  isIndex: boolean
  isExpanded: (path: string) => boolean
  toggle: (path: string) => void
}) {
  const tag = bsonTypeOf(value)
  const container = isContainer(tag)
  const open = container && isExpanded(path)
  const [shown, setShown] = useState(PAGE)

  const keyEl = (
    <span className={cn('shrink-0', isIndex ? 'text-json-punct' : 'text-json-key')}>
      {name}
      <span className="text-json-punct">:</span>
    </span>
  )

  if (!container) {
    return (
      <Row depth={depth} path={path} value={value} tag={tag}>
        {keyEl}
        <ScalarValue value={value} tag={tag} />
      </Row>
    )
  }

  const entries = childEntries(value)
  const count = entries.length
  const preview =
    tag === 'array'
      ? `[ ${count} item${count === 1 ? '' : 's'} ]`
      : `{ ${count} field${count === 1 ? '' : 's'} }`

  return (
    <>
      <Row depth={depth} path={path} value={value} tag={tag} onToggle={() => toggle(path)} expanded={open}>
        {keyEl}
        <span className="text-json-punct">
          {open ? (tag === 'array' ? `Array (${count})` : `Object (${count})`) : preview}
        </span>
      </Row>
      {open && (
        <>
          {entries.slice(0, shown).map(([k, v]) => (
            <Node
              key={k}
              name={k}
              value={v}
              path={`${path}.${k}`}
              depth={depth + 1}
              isIndex={tag === 'array'}
              isExpanded={isExpanded}
              toggle={toggle}
            />
          ))}
          {count > shown && (
            <div style={{ paddingLeft: indent(depth + 1) }} className="py-0.5">
              <button
                type="button"
                className="font-sans text-[11px] text-primary hover:underline"
                onClick={() => setShown(shown + PAGE)}
              >
                Show {Math.min(PAGE, count - shown)} more of {count - shown} remaining
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}

const indent = (depth: number) => 10 + depth * 16

function Row({
  depth,
  path,
  value,
  tag,
  onToggle,
  expanded,
  children
}: {
  depth: number
  path: string
  value: unknown
  tag: BsonTypeTag
  onToggle?: () => void
  expanded?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'group/row relative flex items-start gap-1.5 pr-20 hover:bg-accent/60',
        onToggle && 'cursor-pointer'
      )}
      style={{ paddingLeft: indent(depth) }}
      onClick={onToggle}
      data-path={path}
      data-type={tag}
    >
      {/* Indent guides */}
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="absolute top-0 bottom-0 w-px bg-border" style={{ left: indent(i) + 6 }} />
      ))}
      <span className="flex h-5 w-3 shrink-0 items-center justify-center text-muted-foreground">
        {onToggle ? (
          <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} aria-hidden />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-wrap items-start gap-x-1.5">{children}</span>
      <span className="absolute top-0 right-2 hidden items-center gap-1 group-hover/row:flex">
        <span
          className="rounded bg-muted px-1 font-sans text-[10px] text-muted-foreground"
          data-testid="type-badge"
        >
          {bsonTypeLabel[tag]}
        </span>
        <button
          type="button"
          title="Copy field path"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            copyText(path)
          }}
        >
          <Route className="size-3" />
        </button>
        <button
          type="button"
          title="Copy value"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            copyText(isContainer(tag) ? toShellString(value) : displayScalar(value, tag))
          }}
        >
          <Copy className="size-3" />
        </button>
      </span>
    </div>
  )
}

function ScalarValue({ value, tag }: { value: unknown; tag: BsonTypeTag }) {
  const [full, setFull] = useState(false)
  const text = displayScalar(value, tag)
  const long = (tag === 'string' || tag === 'binary') && text.length > MAX_STRING
  return (
    <span
      className={cn('selectable min-w-0 break-all', typeColor[tag])}
      title={describeValue(value, tag)}
      data-testid="json-value"
    >
      {long && !full ? `${text.slice(0, MAX_STRING)}…` : text}
      {long && (
        <button
          type="button"
          className="ml-1.5 font-sans text-[11px] text-primary hover:underline"
          onClick={(e) => {
            e.stopPropagation()
            setFull(!full)
          }}
        >
          {full ? 'show less' : `show all ${text.length.toLocaleString()} chars`}
        </button>
      )}
    </span>
  )
}

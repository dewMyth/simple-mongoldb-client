/**
 * Inline document editor: rename keys, edit values with validation, change types via a
 * dropdown (converting or explaining why not), delete fields and add fields/array items.
 * Every committed change goes through the DocEditor (undo/redo, diff).
 */
import { useState, type KeyboardEvent } from 'react'
import type { Document } from 'bson'
import { ChevronRight, Lock, Plus, Trash2 } from 'lucide-react'
import { bsonTypeLabel, bsonTypeOf, isContainer, type BsonTypeTag } from '@shared/bson-types'
import { deleteAt, insertAt, renameKey, setAt, type Path } from '@shared/doc-edit'
import { convertValue, editableTypes, editText, parseEditValue } from '@shared/edit-values'
import { cn } from '@renderer/lib/utils'
import { typeColor } from '../bson-style'
import type { DocEditor } from './useDocEditor'

const PAGE = 50
const indent = (depth: number) => 10 + depth * 16
const isEditableType = (t: BsonTypeTag) => (editableTypes as readonly string[]).includes(t)

function entriesOf(value: unknown): [string | number, unknown][] {
  return Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value as Record<string, unknown>)
}

/** A sensible blank value of a type (0 for numbers, '' for strings…), or '' if none fits. */
function emptyValueOf(type: BsonTypeTag): unknown {
  for (const seed of ['0', '', 'false']) {
    const r = convertValue(seed, type)
    if (r.ok) return r.value
  }
  return ''
}

function uniqueKey(obj: Record<string, unknown>, base = 'field'): string {
  if (!(base in obj)) return base
  for (let i = 1; ; i++) if (!(`${base}${i}` in obj)) return `${base}${i}`
}

export function EditableTree({ editor }: { editor: DocEditor }) {
  return (
    <div className="font-mono text-[12px] leading-5" data-testid="editable-tree">
      {entriesOf(editor.draft).map(([k, v]) => (
        <EditableNode key={String(k)} name={k} value={v} path={[k]} depth={0} editor={editor} />
      ))}
      <AddRow parentPath={[]} parent={editor.draft} depth={0} editor={editor} />
    </div>
  )
}

function EditableNode({
  name,
  value,
  path,
  depth,
  editor
}: {
  name: string | number
  value: unknown
  path: Path
  depth: number
  editor: DocEditor
}) {
  const tag = bsonTypeOf(value)
  const container = isContainer(tag)
  const [open, setOpen] = useState(depth === 0 && container && entriesOf(value).length <= 20)
  const [shown, setShown] = useState(PAGE)
  const [typeError, setTypeError] = useState<string | null>(null)
  const isId = depth === 0 && name === '_id'
  const changed = editor.isChanged(path)

  const changeType = (to: BsonTypeTag) => {
    const res = convertValue(value, to)
    if (!res.ok) return setTypeError(res.error)
    setTypeError(null)
    editor.apply((d) => setAt(d, path, res.value))
    if (to === 'object' || to === 'array') setOpen(true)
  }

  return (
    <>
      <div
        className={cn(
          'group/row relative flex items-center gap-1.5 py-px pr-2 hover:bg-accent/50',
          changed && 'bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]'
        )}
        style={{ paddingLeft: indent(depth) }}
        data-path={path.join('.')}
        data-type={tag}
        data-changed={changed || undefined}
      >
        <button
          type="button"
          className={cn(
            'flex h-5 w-3 shrink-0 items-center justify-center text-muted-foreground',
            !container && 'invisible'
          )}
          onClick={() => setOpen(!open)}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        </button>
        <KeyEditor name={name} path={path} editor={editor} locked={isId} />
        <span className="text-json-punct">:</span>
        <div className="min-w-0 flex-1">
          {isId ? (
            <span
              className={cn('flex items-center gap-1', typeColor[tag])}
              title="_id can't be changed. Clone the document instead."
            >
              <Lock className="size-3 text-muted-foreground" />
              {container ? '{…}' : editText(value) || String(value)}
            </span>
          ) : container ? (
            <span className="text-json-punct">
              {tag === 'array'
                ? `[ ${(value as unknown[]).length} items ]`
                : `{ ${Object.keys(value as object).length} fields }`}
            </span>
          ) : isEditableType(tag) ? (
            <ValueEditor value={value} tag={tag} path={path} editor={editor} />
          ) : (
            <span className={cn('italic', typeColor[tag])} title="Edit this value with “Edit as JSON”">
              {bsonTypeLabel[tag]} (edit as JSON)
            </span>
          )}
        </div>
        {!isId && (
          <>
            <select
              aria-label="Type"
              value={tag}
              onChange={(e) => changeType(e.target.value as BsonTypeTag)}
              className="h-6 w-28 shrink-0 rounded border border-input bg-background px-1 font-sans text-[11px] text-muted-foreground outline-none focus:border-ring"
              data-testid="type-select"
            >
              {!isEditableType(tag) && (
                <option value={tag} disabled>
                  {bsonTypeLabel[tag]}
                </option>
              )}
              {editableTypes.map((t) => (
                <option key={t} value={t}>
                  {bsonTypeLabel[t]}
                </option>
              ))}
            </select>
            <button
              type="button"
              title="Delete field"
              aria-label={`Delete ${String(name)}`}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-destructive/10 hover:text-destructive focus:opacity-100"
              onClick={() => editor.apply((d) => deleteAt(d, path))}
              data-testid="delete-field"
            >
              <Trash2 className="size-3" />
            </button>
          </>
        )}
      </div>
      {typeError && (
        <div
          className="py-0.5 font-sans text-[11px] text-destructive"
          style={{ paddingLeft: indent(depth) + 20 }}
          data-testid="type-error"
        >
          {typeError}
        </div>
      )}
      {container && open && (
        <>
          {entriesOf(value)
            .slice(0, shown)
            .map(([k, v]) => (
              <EditableNode
                key={String(k)}
                name={k}
                value={v}
                path={[...path, k]}
                depth={depth + 1}
                editor={editor}
              />
            ))}
          {entriesOf(value).length > shown && (
            <div style={{ paddingLeft: indent(depth + 1) + 20 }}>
              <button
                type="button"
                className="font-sans text-[11px] text-primary hover:underline"
                onClick={() => setShown(shown + PAGE)}
              >
                Show {PAGE} more
              </button>
            </div>
          )}
          <AddRow parentPath={path} parent={value} depth={depth + 1} editor={editor} />
        </>
      )}
    </>
  )
}

function KeyEditor({
  name,
  path,
  editor,
  locked
}: {
  name: string | number
  path: Path
  editor: DocEditor
  locked: boolean
}) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (typeof name === 'number') return <span className="shrink-0 text-json-punct">{name}</span>
  if (locked) return <span className="shrink-0 text-json-key">{name}</span>

  const commit = () => {
    if (text === null || text === name) return setText(null)
    if (!text) return setError('Field name is required')
    try {
      editor.apply((d) => renameKey(d, path.slice(0, -1), name, text))
      setText(null)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <input
      aria-label="Field name"
      value={text ?? name}
      size={Math.max(2, (text ?? name).length)}
      onChange={(e) => {
        setText(e.target.value)
        setError(null)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(null)
          setError(null)
        }
      }}
      title={error ?? 'Click to rename'}
      className={cn(
        'shrink-0 rounded border border-transparent bg-transparent px-0.5 text-json-key outline-none hover:border-input focus:border-ring',
        error && 'border-destructive'
      )}
      data-testid="key-input"
    />
  )
}

function ValueEditor({
  value,
  tag,
  path,
  editor
}: {
  value: unknown
  tag: BsonTypeTag
  path: Path
  editor: DocEditor
}) {
  const original = editText(value)
  // Local text while typing; null means "show the committed value".
  const [text, setText] = useState<string | null>(null)
  const current = text ?? original
  const parsed = text === null ? null : parseEditValue(text, tag, value)
  const error = parsed && !parsed.ok ? parsed.error : null

  const commit = () => {
    if (text === null) return
    if (parsed?.ok && text !== original) editor.apply((d) => setAt(d, path, parsed.value))
    if (!parsed || parsed.ok) setText(null)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
    }
    if (e.key === 'Escape') setText(null)
  }

  if (tag === 'null') return <span className="text-json-null italic">null</span>
  if (tag === 'boolean')
    return (
      <select
        aria-label="Value"
        value={String(value)}
        onChange={(e) => editor.apply((d) => setAt(d, path, e.target.value === 'true'))}
        className={cn(
          'h-6 rounded border border-input bg-background px-1 outline-none focus:border-ring',
          typeColor[tag]
        )}
        data-testid="value-input"
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )

  const multiline = tag === 'string' && (current.includes('\n') || current.length > 80)
  const common = {
    'aria-label': 'Value',
    value: current,
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: commit,
    onKeyDown: onKey,
    title: error ?? undefined,
    'aria-invalid': !!error,
    'data-testid': 'value-input',
    className: cn(
      'selectable w-full min-w-0 rounded border bg-transparent px-1 outline-none focus:border-ring focus:bg-background',
      error ? 'border-destructive' : 'border-transparent hover:border-input',
      typeColor[tag]
    )
  }
  return (
    <div>
      {multiline ? (
        <textarea
          {...common}
          rows={Math.min(8, current.split('\n').length + Math.floor(current.length / 100))}
          className={cn(common.className, 'resize-y py-0.5')}
        />
      ) : (
        <input {...common} />
      )}
      {error && (
        <div className="font-sans text-[11px] text-destructive" data-testid="value-error">
          {error}
        </div>
      )}
    </div>
  )
}

function AddRow({
  parentPath,
  parent,
  depth,
  editor
}: {
  parentPath: Path
  parent: unknown
  depth: number
  editor: DocEditor
}) {
  const isArray = Array.isArray(parent)
  const add = () =>
    editor.apply((d: Document) => {
      if (isArray) {
        const arr = parent as unknown[]
        // New items copy the type of the last item (as an empty value of that type), else string.
        const lastTag = arr.length ? bsonTypeOf(arr[arr.length - 1]) : 'string'
        const type = isEditableType(lastTag) && !isContainer(lastTag) ? lastTag : 'string'
        return insertAt(d, parentPath, arr.length, emptyValueOf(type))
      }
      return insertAt(d, parentPath, uniqueKey(parent as Record<string, unknown>), '')
    })
  return (
    <div style={{ paddingLeft: indent(depth) + 20 }} className="py-0.5">
      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1 font-sans text-[11px] text-muted-foreground hover:text-primary"
        data-testid={isArray ? 'add-item' : 'add-field'}
      >
        <Plus className="size-3" /> {isArray ? 'Add item' : 'Add field'}
      </button>
    </div>
  )
}

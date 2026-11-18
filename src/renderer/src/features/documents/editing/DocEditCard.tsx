/**
 * Editing one document, inline (tree) or as shell-syntax JSON, with conflict-safe saving.
 */
import { useEffect, useState, useMemo } from 'react'
import type { Document } from 'bson'
import { Redo2, Undo2 } from 'lucide-react'
import { fromBsonBytes, toBsonBytes, type BsonBytes } from '@shared/bson-wire'
import { toShellPreview, toShellString } from '@shared/shell-format'
import { Button } from '../../../components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../../components/ui/alert-dialog'
import { CodeEditor, type EditorError } from '../../../components/CodeEditor'
import { ErrorBox, Spinner } from '../../../components/form'
import { ipc } from '../../../lib/ipc'
import { useResultsStore } from '../results-store'
import { useDocsTarget } from '../docs-context'
import { EditableTree } from './EditableTree'
import { useDocEditor } from './useDocEditor'

export type EditMode = 'inline' | 'json'

interface Conflict {
  edited: BsonBytes
  current: BsonBytes | null
}

/** Save → handle updated / unchanged / conflict. Shared by both edit modes. */
function useSave(index: number, raw: BsonBytes, onDone: () => void) {
  const { tabId, connectionId, ns } = useDocsTarget()
  const replaceAt = useResultsStore((s) => s.replaceAt)
  const removeAt = useResultsStore((s) => s.removeAt)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)

  const save = async (edited: BsonBytes, force = false) => {
    setSaving(true)
    setError(null)
    try {
      const res = await ipc('docs:update', { connectionId, ns, original: raw, edited, force })
      if (res.status === 'conflict') return setConflict({ edited, current: res.current })
      setConflict(null)
      if (res.status === 'updated') {
        if (res.doc) replaceAt(tabId, index, res.doc)
        else removeAt(tabId, index)
      }
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const reload = () => {
    if (!conflict) return
    if (conflict.current) replaceAt(tabId, index, conflict.current)
    else removeAt(tabId, index)
    setConflict(null)
    onDone()
  }

  return { save, saving, error, conflict, setConflict, reload }
}

export function DocEditCard({
  index,
  doc,
  raw,
  mode,
  onDone
}: {
  index: number
  doc: Document
  raw: BsonBytes
  mode: EditMode
  onDone: () => void
}) {
  const s = useSave(index, raw, onDone)
  return (
    <div className="rounded-md border-2 border-primary/40 bg-card" data-testid="doc-editor">
      {mode === 'inline' ? (
        <InlineEditor doc={doc} saveState={s} onCancel={onDone} />
      ) : (
        <JsonEditor doc={doc} saveState={s} onCancel={onDone} />
      )}
      <ConflictDialog
        conflict={s.conflict}
        saving={s.saving}
        onKeepEditing={() => s.setConflict(null)}
        onReload={s.reload}
        onOverwrite={() => s.conflict && void s.save(s.conflict.edited, true)}
      />
    </div>
  )
}

type SaveState = ReturnType<typeof useSave>

function Footer({
  changes,
  saveState,
  onCancel,
  onSave,
  children,
  saveDisabled
}: {
  changes: string
  saveState: SaveState
  onCancel: () => void
  onSave: () => void
  children?: React.ReactNode
  saveDisabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-2 border-t px-3 py-2">
      {saveState.error && <ErrorBox>{saveState.error}</ErrorBox>}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground" data-testid="change-count">
          {changes}
        </span>
        {children}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel} data-testid="edit-cancel">
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={saveState.saving || saveDisabled}
          data-testid="edit-save"
        >
          {saveState.saving ? <Spinner className="size-3" /> : null} Update
        </Button>
      </div>
    </div>
  )
}

function InlineEditor({
  doc,
  saveState,
  onCancel
}: {
  doc: Document
  saveState: SaveState
  onCancel: () => void
}) {
  const editor = useDocEditor(doc)
  const onSave = () => void saveState.save(toBsonBytes(editor.draft))
  return (
    <div
      onKeyDown={(e) => {
        const mod = e.metaKey || e.ctrlKey
        const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
        if (mod && e.key.toLowerCase() === 's') {
          e.preventDefault()
          ;(document.activeElement as HTMLElement | null)?.blur()
          setTimeout(onSave, 0) // after the focused field commits
        } else if (mod && e.key.toLowerCase() === 'z' && !typing) {
          e.preventDefault()
          if (e.shiftKey) editor.redo()
          else editor.undo()
        } else if (e.key === 'Escape' && !typing) onCancel()
      }}
    >
      <div className="py-1.5">
        <EditableTree editor={editor} />
      </div>
      <Footer
        changes={editor.changes ? `${editor.changes} change${editor.changes === 1 ? '' : 's'}` : 'No changes'}
        saveState={saveState}
        onCancel={onCancel}
        onSave={onSave}
        saveDisabled={!editor.changes}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Undo"
          title="Undo (⌘Z)"
          disabled={!editor.canUndo}
          onClick={editor.undo}
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Redo"
          title="Redo (⌘⇧Z)"
          disabled={!editor.canRedo}
          onClick={editor.redo}
        >
          <Redo2 />
        </Button>
      </Footer>
    </div>
  )
}

function JsonEditor({
  doc,
  saveState,
  onCancel
}: {
  doc: Document
  saveState: SaveState
  onCancel: () => void
}) {
  const { connectionId, ns } = useDocsTarget()
  const completion = useMemo(() => ({ mode: 'document' as const, connectionId, ns }), [connectionId, ns])
  const [text, setText] = useState(() => toShellString(doc))
  const [error, setError] = useState<EditorError | null>(null)

  // Live parse (debounced) so errors show while typing.
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      ipc('docs:parse', text)
        .then((r) => {
          if (cancelled) return
          if (!r.ok) setError(r.error)
          else if (r.docs.length !== 1) setError({ message: 'Edit exactly one document' })
          else setError(null)
        })
        .catch(() => {})
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [text])

  const onSave = async (current: string = text) => {
    const r = await ipc('docs:parse', current)
    if (!r.ok) return setError(r.error)
    if (r.docs.length !== 1) return setError({ message: 'Edit exactly one document' })
    await saveState.save(r.docs[0]!)
  }

  return (
    <div className="p-2">
      <CodeEditor
        value={text}
        onChange={setText}
        onSubmit={(t) => void onSave(t)}
        error={error}
        testId="json-doc-editor"
        maxHeight={560}
        completion={completion}
      />
      {error && <div className="px-1 pt-1 text-xs text-destructive">{error.message}</div>}
      <Footer
        changes="Shell syntax: NumberLong(…), ISODate(…) keep their types. ⌘↵ to save."
        saveState={saveState}
        onCancel={onCancel}
        onSave={() => void onSave()}
        saveDisabled={!!error}
      />
    </div>
  )
}

function ConflictDialog({
  conflict,
  saving,
  onKeepEditing,
  onReload,
  onOverwrite
}: {
  conflict: Conflict | null
  saving: boolean
  onKeepEditing: () => void
  onReload: () => void
  onOverwrite: () => void
}) {
  const current = conflict?.current ? toShellPreview(fromBsonBytes(conflict.current), 4000) : null
  return (
    <AlertDialog open={!!conflict} onOpenChange={(o) => !o && onKeepEditing()}>
      <AlertDialogContent className="sm:max-w-lg" data-testid="conflict-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-sm">Document changed on server</AlertDialogTitle>
          <AlertDialogDescription className="text-[13px]">
            {current
              ? 'Someone changed a field you edited since you loaded this document. Your changes were not saved.'
              : 'This document was deleted on the server since you loaded it. Your changes were not saved.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {current && (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Current version on the server:</div>
            <pre className="selectable max-h-60 overflow-auto rounded border bg-muted/50 p-2 font-mono text-[11px]">
              {current.text}
              {current.truncated ? '\n…' : ''}
            </pre>
          </div>
        )}
        <AlertDialogFooter className="gap-2 sm:justify-between">
          <AlertDialogCancel size="sm" onClick={onKeepEditing} data-testid="conflict-keep">
            Keep editing
          </AlertDialogCancel>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onReload} data-testid="conflict-reload">
              {current ? 'Reload (discard mine)' : 'Discard my changes'}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={onOverwrite}
              disabled={saving}
              data-testid="conflict-overwrite"
            >
              {current ? 'Overwrite with mine' : 'Re-create with mine'}
            </Button>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

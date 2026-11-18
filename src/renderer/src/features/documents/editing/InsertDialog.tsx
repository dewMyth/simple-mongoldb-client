/** Insert one document or an array of documents, written in shell syntax. */
import { useEffect, useState } from 'react'
import { CodeEditor, type EditorError } from '../../../components/CodeEditor'
import { Dialog } from '../../../components/Dialog'
import { ErrorBox, Spinner } from '../../../components/form'
import { Button } from '../../../components/ui/button'
import { ipc } from '../../../lib/ipc'
import { useResultsStore } from '../results-store'
import { useDocsTarget } from '../docs-context'

export const EMPTY_INSERT = '{\n  \n}'

export function InsertDialog({ initialText, onClose }: { initialText: string; onClose: () => void }) {
  const { tabId, connectionId, ns } = useDocsTarget()
  const refresh = useResultsStore((s) => s.refresh)
  const [text, setText] = useState(initialText)
  const [error, setError] = useState<EditorError | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    inserted: number
    errors: { index: number; message: string }[]
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      ipc('docs:parse', text)
        .then((r) => {
          if (cancelled) return
          setError(r.ok ? null : r.error)
          setCount(r.ok ? r.docs.length : null)
        })
        .catch(() => {})
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [text])

  const insert = async (current: string = text) => {
    setBusy(true)
    try {
      const parsed = await ipc('docs:parse', current)
      if (!parsed.ok) return setError(parsed.error)
      const res = await ipc('docs:insert', { connectionId, ns, docs: parsed.docs })
      await refresh(tabId)
      if (res.errors.length) setResult({ inserted: res.insertedCount, errors: res.errors })
      else onClose()
    } catch (e) {
      setError({ message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width="lg"
      title={`Insert into ${ns}`}
      description="One document { … } or an array [ { … }, { … } ] in shell syntax. NumberLong(…), ISODate(…), ObjectId(…) keep their types; _id is generated when omitted."
      footer={
        <>
          <span className="mr-auto text-xs text-muted-foreground" data-testid="insert-count">
            {count !== null ? `${count} document${count === 1 ? '' : 's'}` : ''}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void insert()}
            disabled={busy || !!error || !count}
            data-testid="insert-submit"
          >
            {busy ? <Spinner className="size-3" /> : null} Insert
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <CodeEditor
          value={text}
          onChange={setText}
          onSubmit={(t) => void insert(t)}
          error={error}
          minLines={10}
          testId="insert-editor"
          completion={{ mode: 'document', connectionId, ns }}
        />
        {error && <div className="text-xs text-destructive">{error.message}</div>}
        {result && (
          <ErrorBox>
            Inserted {result.inserted}; {result.errors.length} failed:
            {'\n'}
            {result.errors
              .slice(0, 20)
              .map((e) => `#${e.index + 1}: ${e.message}`)
              .join('\n')}
          </ErrorBox>
        )}
      </div>
    </Dialog>
  )
}

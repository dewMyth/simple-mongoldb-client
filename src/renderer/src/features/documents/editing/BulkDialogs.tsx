/** "Update all matching" (with a before/after preview) and "Delete all matching" (typed confirmation). */
import { useEffect, useState } from 'react'
import { fromBsonBytes } from '@shared/bson-wire'
import type { QueryText } from '@shared/query'
import { toShellPreview } from '@shared/shell-format'
import { CodeEditor } from '../../../components/CodeEditor'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { Dialog } from '../../../components/Dialog'
import { ErrorBox, Spinner } from '../../../components/form'
import { Button } from '../../../components/ui/button'
import { ipc } from '../../../lib/ipc'
import { useResultsStore } from '../results-store'
import { useDocsTarget } from '../docs-context'

function filterSummary(q: QueryText) {
  return q.filter.trim() || '{}  (every document)'
}

function useMatchCount(): { text: string; exact: number | null } {
  const { tabId } = useDocsTarget()
  const r = useResultsStore((s) => s.byTab[tabId])
  if (!r?.count) return { text: 'an unknown number of', exact: null }
  return r.count.exact
    ? { text: r.count.value.toLocaleString(), exact: r.count.value }
    : { text: `at least ${r.count.value.toLocaleString()}`, exact: null }
}

const preview = (bytes: Uint8Array) => toShellPreview(fromBsonBytes(bytes), 3000).text

export function BulkUpdateDialog({ query, onClose }: { query: QueryText; onClose: () => void }) {
  const { tabId, connectionId, ns } = useDocsTarget()
  const refresh = useResultsStore((s) => s.refresh)
  const count = useMatchCount()
  const [text, setText] = useState('{\n  $set: {\n    \n  }\n}')
  const [items, setItems] = useState<{ before: string; after: string }[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      setLoading(true)
      ipc('docs:previewUpdate', { connectionId, ns, query, update: text })
        .then((r) => {
          if (cancelled) return
          if (r.ok) {
            setItems(r.items.map((i) => ({ before: preview(i.before), after: preview(i.after) })))
            setPreviewError(null)
          } else {
            setItems(null)
            setPreviewError(r.error)
          }
        })
        .catch((e) => !cancelled && setPreviewError((e as Error).message))
        .finally(() => !cancelled && setLoading(false))
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [text, connectionId, ns, query])

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width="xl"
      title={`Update documents in ${ns}`}
      description={`Applies to ${count.text} documents matching the current filter.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => setConfirming(true)} data-testid="bulk-update-submit">
            Update {count.text} documents
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-xs">
          <span className="text-muted-foreground">Filter: </span>
          <code className="selectable font-mono">{filterSummary(query)}</code>
        </div>
        <CodeEditor
          value={text}
          onChange={setText}
          minLines={7}
          testId="bulk-update-editor"
          completion={{ mode: 'update', connectionId, ns }}
        />
        <div className="flex items-center gap-2 text-xs font-medium">
          Preview (first 5 matching documents, nothing is written) {loading && <Spinner className="size-3" />}
        </div>
        {previewError && (
          <div className="text-xs text-muted-foreground" data-testid="preview-error">
            {previewError}
          </div>
        )}
        {items && items.length === 0 && (
          <div className="text-xs text-muted-foreground">No documents match the filter.</div>
        )}
        {items?.map((it, i) => (
          <div key={i} className="grid grid-cols-2 gap-2" data-testid="preview-item">
            <pre className="selectable max-h-48 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px]">
              {it.before}
            </pre>
            <pre
              className="selectable max-h-48 overflow-auto rounded border border-primary/40 bg-primary/5 p-2 font-mono text-[11px]"
              data-testid="preview-after"
            >
              {it.after}
            </pre>
          </div>
        ))}
        {error && <ErrorBox>{error}</ErrorBox>}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Update documents"
        body={
          <>
            Apply this update to <b>{count.text}</b> documents in <b>{ns}</b>?
          </>
        }
        confirmLabel="Update"
        onConfirm={async () => {
          try {
            const res = await ipc('docs:updateMany', { connectionId, ns, query, update: text })
            await refresh(tabId)
            setError(null)
            onClose()
            return res
          } catch (e) {
            setError((e as Error).message)
            throw e
          }
        }}
      />
    </Dialog>
  )
}

export function BulkDeleteDialog({ query, onClose }: { query: QueryText; onClose: () => void }) {
  const { tabId, connectionId, ns } = useDocsTarget()
  const refresh = useResultsStore((s) => s.refresh)
  const count = useMatchCount()
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Delete matching documents"
      body={
        <>
          Permanently delete <b>{count.text}</b> documents from <b>{ns}</b> matching{' '}
          <code className="selectable font-mono">{filterSummary(query)}</code>?
        </>
      }
      typeToConfirm={count.exact !== null ? String(count.exact) : 'delete'}
      confirmLabel="Delete documents"
      onConfirm={async () => {
        await ipc('docs:deleteMany', { connectionId, ns, query })
        await refresh(tabId)
      }}
    />
  )
}

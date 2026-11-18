/**
 * Per-document actions shown on hover: edit inline, edit as JSON, clone, delete.
 * Each is disabled (with the reason in its tooltip) when the user lacks the privilege, the
 * namespace is a view, or the document has no _id.
 */
import { useState } from 'react'
import type { Document } from 'bson'
import { CopyPlus, FileCode2, Pencil, Trash2 } from 'lucide-react'
import type { PermissionCheck } from '@shared/permissions'
import { formatScalar } from '@shared/shell-format'
import { IconButton } from '../../../components/IconButton'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { ipc } from '../../../lib/ipc'
import { useWriteCheck } from './use-write-check'
import { useResultsStore } from '../results-store'
import { useDocsTarget } from '../docs-context'
import type { EditMode } from './DocEditCard'

const label = (base: string, c: PermissionCheck) =>
  c.allowed ? base : `${base}: ${c.reason ?? 'not allowed'}`

export function DocActions({
  doc,
  index,
  onEdit,
  onClone
}: {
  doc: Document
  index: number
  onEdit: (mode: EditMode) => void
  onClone: (doc: Document) => void
}) {
  const { tabId, connectionId, ns } = useDocsTarget()
  const raw = useResultsStore((s) => s.byTab[tabId]?.raw[index])
  const refresh = useResultsStore((s) => s.refresh)
  const [deleting, setDeleting] = useState(false)
  const hasId = '_id' in doc
  const noId: PermissionCheck = {
    allowed: false,
    reason: 'This document has no _id, so it can’t be edited safely'
  }
  const canUpdate = useWriteCheck('update')
  const insert = useWriteCheck('insert')
  const canRemove = useWriteCheck('remove')
  const update = hasId ? canUpdate : noId
  const remove = hasId ? canRemove : noId

  return (
    <>
      <IconButton
        label={label('Edit', update)}
        disabled={!update.allowed}
        onClick={() => onEdit('inline')}
        className="size-6"
        data-testid="doc-edit"
      >
        <Pencil className="size-3.5" />
      </IconButton>
      <IconButton
        label={label('Edit as JSON', update)}
        disabled={!update.allowed}
        onClick={() => onEdit('json')}
        className="size-6"
        data-testid="doc-edit-json"
      >
        <FileCode2 className="size-3.5" />
      </IconButton>
      <IconButton
        label={label('Clone', insert)}
        disabled={!insert.allowed}
        onClick={() => onClone(doc)}
        className="size-6"
        data-testid="doc-clone"
      >
        <CopyPlus className="size-3.5" />
      </IconButton>
      <IconButton
        label={label('Delete', remove)}
        disabled={!remove.allowed}
        onClick={() => setDeleting(true)}
        className="size-6 hover:text-destructive"
        data-testid="doc-delete"
      >
        <Trash2 className="size-3.5" />
      </IconButton>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete document"
        body={
          <>
            Delete the document with{' '}
            <code className="font-mono">_id: {formatScalar(doc['_id']) ?? '{…}'}</code> from <b>{ns}</b>? This
            can’t be undone.
          </>
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!raw) return
          await ipc('docs:deleteOne', { connectionId, ns, original: raw })
          await refresh(tabId)
        }}
      />
    </>
  )
}

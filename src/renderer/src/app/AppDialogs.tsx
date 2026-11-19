import { useDialogStore } from '../stores/dialogs'
import { ExportDialog } from '../features/import-export/ExportDialog'
import { ImportDialog } from '../features/import-export/ImportDialog'

/** Dialogs opened from anywhere through the dialog store. */
export function AppDialogs() {
  const dialog = useDialogStore((s) => s.dialog)
  const close = useDialogStore((s) => s.close)
  if (!dialog) return null
  if (dialog.kind === 'export')
    return (
      <ExportDialog connectionId={dialog.connectionId} ns={dialog.ns} query={dialog.query} onClose={close} />
    )
  return <ImportDialog connectionId={dialog.connectionId} ns={dialog.ns} onClose={close} />
}

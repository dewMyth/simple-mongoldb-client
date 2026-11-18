import { useState, type ReactNode } from 'react'
import { Dialog } from './Dialog'
import { Button, ErrorBox, Input, Spinner } from './ui'

/**
 * Confirmation for destructive actions. With `typeToConfirm`, the user must type that exact text.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = 'Confirm',
  typeToConfirm,
  danger = true,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  body: ReactNode
  confirmLabel?: string
  typeToConfirm?: string
  danger?: boolean
  onConfirm: () => Promise<unknown> | unknown
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ok = !typeToConfirm || typed === typeToConfirm

  const close = (v: boolean) => {
    if (!v) {
      setTyped('')
      setError(null)
    }
    onOpenChange(v)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      width="sm"
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={!ok || busy}
            data-testid="confirm-button"
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await onConfirm()
                close(false)
              } catch (e) {
                setError((e as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <div>{body}</div>
        {typeToConfirm ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">
              Type{' '}
              <code className="selectable rounded bg-panel-2 px-1 font-mono text-fg">{typeToConfirm}</code> to
              confirm
            </span>
            <Input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="confirm-input"
            />
          </label>
        ) : null}
        {error ? <ErrorBox>{error}</ErrorBox> : null}
      </div>
    </Dialog>
  )
}

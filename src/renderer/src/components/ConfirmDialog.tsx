import { useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ErrorBox, Spinner } from './form'

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

  const confirm = async () => {
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
  }

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-sm">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-[13px]">{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {typeToConfirm ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
              Type{' '}
              <code className="selectable rounded bg-muted px-1 font-mono text-foreground">
                {typeToConfirm}
              </code>{' '}
              to confirm
            </span>
            <Input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ok && void confirm()}
              data-testid="confirm-input"
            />
          </label>
        ) : null}
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <AlertDialogFooter>
          <AlertDialogCancel size="default">Cancel</AlertDialogCancel>
          {/* A plain Button (not AlertDialogAction) so the dialog stays open while working/on error. */}
          <Button
            variant={danger ? 'destructive' : 'default'}
            disabled={!ok || busy}
            onClick={confirm}
            data-testid="confirm-button"
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

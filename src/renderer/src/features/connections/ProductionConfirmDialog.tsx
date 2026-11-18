/** The confirmation shown before each write to a production connection (see production-guard.ts). */
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../../components/ui/alert-dialog'
import { Button } from '../../components/ui/button'
import { answer, useConfirmQueue } from './production-guard'

export function ProductionConfirmDialog() {
  const req = useConfirmQueue((s) => s.queue[0])
  return (
    <AlertDialog open={!!req} onOpenChange={(o) => !o && answer(false)}>
      <AlertDialogContent className="border-2 border-destructive" data-testid="production-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-sm">Write to production?</AlertDialogTitle>
          <AlertDialogDescription className="text-xs">
            <b className="text-destructive">{req?.connection}</b> is marked as a production connection.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm" data-testid="production-confirm-action">
          {req?.action}.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer(false)} data-testid="production-cancel">
            Cancel
          </AlertDialogCancel>
          <Button variant="destructive" onClick={() => answer(true)} data-testid="production-proceed">
            Yes, write to production
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

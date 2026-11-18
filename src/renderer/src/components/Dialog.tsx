import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'
import {
  Dialog as ShadDialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'

const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl', xl: 'sm:max-w-5xl' }

/** shadcn Dialog with a scrollable body and a fixed header/footer. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: keyof typeof widths
}) {
  return (
    <ShadDialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('flex max-h-[88vh] flex-col gap-0 p-0', widths[width])}>
        <DialogHeader className="border-b px-5 py-3.5">
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className={cn('text-xs', !description && 'sr-only')}>
            {description ?? title}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer ? <DialogFooter className="border-t px-5 py-3">{footer}</DialogFooter> : null}
      </DialogContent>
    </ShadDialog>
  )
}

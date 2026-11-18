import * as RD from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import clsx from 'clsx'
import type { ReactNode } from 'react'

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
  width?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RD.Content
          className={clsx(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-bg shadow-2xl outline-none',
            width === 'sm' && 'max-w-md',
            width === 'md' && 'max-w-xl',
            width === 'lg' && 'max-w-3xl',
            width === 'xl' && 'max-w-5xl'
          )}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
            <div>
              <RD.Title className="text-sm font-semibold">{title}</RD.Title>
              {description ? (
                <RD.Description className="mt-0.5 text-xs text-muted">{description}</RD.Description>
              ) : null}
            </div>
            <RD.Close className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg" aria-label="Close">
              <X size={15} />
            </RD.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              {footer}
            </div>
          ) : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}

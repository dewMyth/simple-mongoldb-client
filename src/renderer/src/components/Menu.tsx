import type { ReactNode } from 'react'
import {
  ContextMenu as Root,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from './ui/context-menu'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Shown as a tooltip when disabled (e.g. missing permission). */
  reason?: string
  separatorBefore?: boolean
}

export function ContextMenu({ items, children }: { items: MenuItem[]; children: ReactNode }) {
  return (
    <Root>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {items.map((item) => (
          <div key={item.label}>
            {item.separatorBefore && <ContextMenuSeparator />}
            <ContextMenuItem
              disabled={item.disabled}
              onSelect={item.onSelect}
              title={item.disabled ? item.reason : undefined}
              variant={item.danger ? 'destructive' : 'default'}
              className="text-[13px]"
            >
              {item.label}
            </ContextMenuItem>
          </div>
        ))}
      </ContextMenuContent>
    </Root>
  )
}

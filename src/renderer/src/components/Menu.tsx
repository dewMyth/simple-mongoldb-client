import * as CM from '@radix-ui/react-context-menu'
import clsx from 'clsx'
import type { ReactNode } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Shown as a tooltip-like suffix when disabled (e.g. missing permission). */
  reason?: string
  separatorBefore?: boolean
}

export function ContextMenu({ items, children }: { items: MenuItem[]; children: ReactNode }) {
  return (
    <CM.Root>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className="z-50 min-w-48 rounded-md border border-border bg-panel p-1 text-[13px] shadow-xl">
          {items.map((item) => (
            <div key={item.label}>
              {item.separatorBefore && <CM.Separator className="my-1 h-px bg-border" />}
              <CM.Item
                disabled={item.disabled}
                onSelect={item.onSelect}
                title={item.disabled ? item.reason : undefined}
                className={clsx(
                  'flex cursor-default items-center rounded px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-panel-2',
                  item.danger ? 'text-danger' : 'text-fg'
                )}
              >
                {item.label}
              </CM.Item>
            </div>
          ))}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  )
}

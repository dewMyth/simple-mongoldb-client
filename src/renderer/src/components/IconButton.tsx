import * as Tooltip from '@radix-ui/react-tooltip'
import clsx from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  children: ReactNode
  active?: boolean
}

/** Icon button with a tooltip. Disabled buttons keep their tooltip (wrapped in a span). */
export function IconButton({ label, children, active, className, disabled, ...rest }: Props) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className="inline-flex">
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            className={clsx(
              'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
              active && 'bg-panel-2 text-fg',
              className
            )}
            {...rest}
          >
            {children}
          </button>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          sideOffset={4}
          className="z-50 max-w-xs rounded-md border border-border bg-panel px-2 py-1 text-xs text-fg shadow-lg"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

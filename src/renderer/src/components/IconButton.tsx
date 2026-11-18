import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** Ghost icon button with a tooltip. Disabled buttons keep their tooltip (wrapped in a span). */
export function IconButton({
  label,
  children,
  active,
  className,
  disabled,
  ...rest
}: ComponentProps<typeof Button> & { label: string; children: ReactNode; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={disabled}
            className={cn(
              'text-muted-foreground hover:text-foreground',
              active && 'bg-accent text-foreground',
              className
            )}
            {...rest}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

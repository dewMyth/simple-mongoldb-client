/**
 * Small form helpers composed from shadcn/ui primitives, so feature code stays terse.
 */
import { useId, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

export { Spinner } from './ui/spinner'

/** Label + control + hint/error, stacked. */
export function Field({
  label,
  hint,
  error,
  children,
  className
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  )
}

export function CheckboxField({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className={cn('flex items-center gap-2', disabled && 'opacity-50')}>
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="text-[13px] font-normal">
        {label}
      </Label>
    </div>
  )
}

/** Radix Select can't use "" as a value, so empty-string options are mapped internally. */
const EMPTY = '__empty__'

export function SimpleSelect<T extends string>({
  value,
  onValueChange,
  options,
  className,
  ariaLabel
}: {
  value: T
  onValueChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  className?: string
  ariaLabel?: string
}) {
  return (
    <Select
      value={value === '' ? EMPTY : value}
      onValueChange={(v) => onValueChange((v === EMPTY ? '' : v) as T)}
    >
      <SelectTrigger className={cn('w-full', className)} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || EMPTY} value={o.value || EMPTY}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="selectable py-2">
      <AlertCircle />
      <AlertDescription className="text-xs break-words whitespace-pre-wrap">{children}</AlertDescription>
    </Alert>
  )
}

export function StatusBadge({
  children,
  tone = 'neutral'
}: {
  children: ReactNode
  tone?: 'neutral' | 'warn' | 'danger' | 'ok'
}) {
  return (
    <Badge
      variant={tone === 'danger' ? 'destructive' : 'secondary'}
      className={cn(
        'px-1.5 py-0 text-[10px] tracking-wide uppercase',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'ok' && 'bg-ok/15 text-ok'
      )}
    >
      {children}
    </Badge>
  )
}

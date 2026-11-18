import clsx from 'clsx'
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes
} from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }
>(function Button({ variant = 'secondary', size = 'md', className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-accent text-accent-fg hover:brightness-110',
        variant === 'secondary' && 'border border-border bg-panel text-fg hover:bg-panel-2',
        variant === 'danger' && 'bg-danger text-white hover:brightness-110',
        variant === 'ghost' && 'text-muted hover:bg-panel-2 hover:text-fg',
        className
      )}
      {...rest}
    />
  )
})

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ className, invalid, ...rest }, ref) {
  return (
    <input
      ref={ref}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      className={clsx(
        'h-8 w-full rounded-md border bg-bg px-2.5 text-[13px] text-fg outline-none placeholder:text-muted/70 focus:border-accent disabled:opacity-60',
        invalid ? 'border-danger' : 'border-border',
        className
      )}
      {...rest}
    />
  )
})

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={clsx(
        'h-8 w-full rounded-md border border-border bg-bg px-2 text-[13px] text-fg outline-none focus:border-accent',
        className
      )}
      {...rest}
    />
  )
}

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
    <label className={clsx('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-muted">{hint}</span>
      ) : null}
    </label>
  )
}

export function Checkbox({
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
  return (
    <label className={clsx('flex items-center gap-2 text-[13px]', disabled && 'opacity-50')}>
      <input
        type="checkbox"
        className="h-3.5 w-3.5 accent-[var(--accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="selectable rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs break-words text-danger">
      {children}
    </div>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
      style={{ width: size, height: size }}
    />
  )
}

export function Badge({
  children,
  tone = 'neutral'
}: {
  children: ReactNode
  tone?: 'neutral' | 'warn' | 'danger' | 'ok'
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase',
        tone === 'neutral' && 'bg-panel-2 text-muted',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'danger' && 'bg-danger/15 text-danger',
        tone === 'ok' && 'bg-ok/15 text-ok'
      )}
    >
      {children}
    </span>
  )
}

import { useState } from 'react'
import { Check, ClipboardCopy } from 'lucide-react'
import { errorDetails } from '@shared/error-details'
import { appInfo } from '../lib/app-info'
import { cn } from '../lib/utils'

/** Copies an error's message, code and the app version/platform (for bug reports). */
export function CopyDetailsButton({
  message,
  error,
  className
}: {
  message: () => string
  error?: unknown
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(errorDetails(message(), error, await appInfo()))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1 text-[11px] opacity-70 hover:bg-destructive/10 hover:opacity-100',
        className
      )}
      onClick={() => void copy()}
      title="Copy the error with the app version, for a bug report"
      data-testid="copy-error-details"
    >
      {copied ? <Check size={12} /> : <ClipboardCopy size={12} />}
      {copied ? 'Copied' : 'Copy details'}
    </button>
  )
}

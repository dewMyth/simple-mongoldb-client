import { Component, type ReactNode } from 'react'
import { CopyDetailsButton } from './CopyDetailsButton'

/**
 * Contains a rendering error to one part of the UI (e.g. one document card) instead of blanking
 * the whole window, and shows what went wrong.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error) {
    console.error(`[${this.props.label ?? 'ui'}]`, error)
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        className="selectable flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        data-testid="render-error"
      >
        <span className="min-w-0 flex-1">
          Couldn't display {this.props.label ?? 'this'}: {this.state.error.message}
        </span>
        <CopyDetailsButton
          message={() => `Render error in ${this.props.label ?? 'the UI'}`}
          error={this.state.error}
        />
      </div>
    )
  }
}

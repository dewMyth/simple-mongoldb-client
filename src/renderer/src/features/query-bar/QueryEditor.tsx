import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { QueryField, QueryFieldError } from '@shared/query'
import { monaco, SHELL_LANGUAGE } from '../../lib/monaco'
import { ipc } from '../../lib/ipc'
import { useThemeStore } from '../../stores/theme'

type IEditor = Parameters<OnMount>[0]

export interface QueryEditorHandlers {
  onRun?: () => void
  onCancel?: () => void
  onHistory?: (direction: 'up' | 'down') => string | null
}

const LINE_HEIGHT = 19
const MAX_LINES = 8
const MARKER_OWNER = 'query-parser'

/**
 * A compact Monaco editor for one query-bar field, with:
 *  - live parse errors from main (debounced) shown as squiggles
 *  - Cmd/Ctrl+Enter run, Esc cancel, Cmd/Ctrl+Shift+F format, ↑/↓ history on the first/last line
 *  - auto-height (1–8 lines)
 */
export function QueryEditor({
  field,
  value,
  onChange,
  placeholder,
  handlers,
  externalError,
  testId,
  autoFocus
}: {
  field: QueryField
  value: string
  onChange: (v: string) => void
  placeholder?: string
  handlers?: QueryEditorHandlers
  /** Error from the last run (e.g. returned by query:find). */
  externalError?: QueryFieldError | null
  testId?: string
  autoFocus?: boolean
}) {
  const resolved = useThemeStore((s) => s.resolved)
  const editorRef = useRef<IEditor | null>(null)
  const handlersRef = useRef(handlers)
  const [height, setHeight] = useState(LINE_HEIGHT + 10)
  const [focused, setFocused] = useState(false)
  const [liveError, setLiveError] = useState<QueryFieldError | null>(null)

  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  // Debounced validation in main (the parser lives there).
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      ipc('query:validate', { field, text: value })
        .then((err) => !cancelled && setLiveError(err))
        .catch(() => {})
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [field, value])

  const error = liveError ?? externalError ?? null

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    if (!error || !value.trim()) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
      return
    }
    const line = Math.min(error.line ?? 1, model.getLineCount())
    const col = error.column ?? 1
    const hasPos = error.line !== undefined
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        startLineNumber: hasPos ? line : 1,
        startColumn: hasPos ? col : 1,
        endLineNumber: hasPos ? line : model.getLineCount(),
        endColumn: hasPos
          ? Math.max(col + 1, model.getLineMaxColumn(line))
          : model.getLineMaxColumn(model.getLineCount())
      }
    ])
  }, [error, value])

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    const updateHeight = () => {
      const lines = Math.min(MAX_LINES, Math.max(1, editor.getModel()?.getLineCount() ?? 1))
      setHeight(lines * LINE_HEIGHT + 10)
    }
    editor.onDidChangeModelContent(updateHeight)
    editor.onDidFocusEditorText(() => setFocused(true))
    editor.onDidBlurEditorText(() => setFocused(false))
    updateHeight()

    const { KeyMod, KeyCode } = monaco
    // addAction, not addCommand: addCommand keybindings are global in Monaco and fire on the
    // most recently created editor, which breaks once the options panel adds more editors.
    editor.addAction({
      id: 'studio.run',
      label: 'Run query',
      keybindings: [KeyMod.CtrlCmd | KeyCode.Enter],
      run: () => handlersRef.current?.onRun?.()
    })
    editor.addAction({
      id: 'studio.format',
      label: 'Format query',
      keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF],
      run: () => {
        if (field !== 'filter' && field !== 'project' && field !== 'sort' && field !== 'collation') return
        void ipc('query:format', { field, text: editor.getValue() }).then((formatted) => {
          if (formatted !== null) {
            editor.executeEdits('format', [
              { range: editor.getModel()!.getFullModelRange(), text: formatted }
            ])
            editor.pushUndoStop()
          }
        })
      }
    })
    editor.onKeyDown((e) => {
      if (e.keyCode === KeyCode.Escape) {
        handlersRef.current?.onCancel?.()
        return
      }
      if (e.keyCode !== KeyCode.UpArrow && e.keyCode !== KeyCode.DownArrow) return
      if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      // Don't hijack arrows while the completion list is open.
      const ctx = (editor as unknown as { _contextKeyService?: { getContextKeyValue(k: string): unknown } })
        ._contextKeyService
      if (ctx?.getContextKeyValue('suggestWidgetVisible')) return
      const pos = editor.getPosition()
      const model = editor.getModel()
      if (!pos || !model) return
      const up = e.keyCode === KeyCode.UpArrow
      if (up ? pos.lineNumber !== 1 : pos.lineNumber !== model.getLineCount()) return
      const recalled = handlersRef.current?.onHistory?.(up ? 'up' : 'down')
      if (recalled === null || recalled === undefined) return
      e.preventDefault()
      e.stopPropagation()
      editor.setValue(recalled)
      editor.setPosition(up ? { lineNumber: 1, column: 1 } : model.getFullModelRange().getEndPosition())
    })
    if (autoFocus) editor.focus()
  }

  return (
    <div
      className={`relative min-w-0 flex-1 rounded-md border bg-background px-1 py-[4px] ${
        error && value.trim() ? 'border-destructive/70' : focused ? 'border-primary' : 'border-border'
      }`}
      data-testid={testId}
      title={error && value.trim() ? error.message : undefined}
    >
      {!value && placeholder ? (
        <div className="pointer-events-none absolute top-[5px] left-[10px] z-10 font-mono text-xs text-muted-foreground/70">
          {placeholder}
        </div>
      ) : null}
      <Editor
        height={height}
        language={SHELL_LANGUAGE}
        theme={resolved === 'dark' ? 'studio-dark' : 'studio-light'}
        value={value}
        onChange={(v) => onChange(v ?? '')}
        onMount={onMount}
        options={{
          minimap: { enabled: false },
          lineNumbers: 'off',
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 4,
          lineNumbersMinChars: 0,
          renderLineHighlight: 'none',
          scrollBeyondLastLine: false,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          scrollbar: {
            vertical: 'auto',
            horizontal: 'hidden',
            verticalScrollbarSize: 8,
            alwaysConsumeMouseWheel: false
          },
          wordWrap: 'on',
          fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: LINE_HEIGHT,
          automaticLayout: true,
          fixedOverflowWidgets: true,
          contextmenu: false,
          tabSize: 2,
          quickSuggestions: false,
          wordBasedSuggestions: 'off',
          suggestOnTriggerCharacters: false,
          parameterHints: { enabled: false },
          renderValidationDecorations: 'on',
          stickyScroll: { enabled: false },
          padding: { top: 0, bottom: 0 }
        }}
      />
    </div>
  )
}

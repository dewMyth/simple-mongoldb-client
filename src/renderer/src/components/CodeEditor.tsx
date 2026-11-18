/**
 * Multi-line Monaco editor for shell-syntax documents (document editing, insert, bulk update).
 * Shows a parse error as a squiggle, and binds Cmd/Ctrl+Enter or Cmd/Ctrl+S to `onSubmit`.
 */
import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { monaco, SHELL_LANGUAGE } from '../lib/monaco'
import { attachCompletion, completionEditorOptions, type CompletionTarget } from '../lib/autocomplete'
import { useThemeStore } from '../stores/theme'

type IEditor = Parameters<OnMount>[0]

export interface EditorError {
  message: string
  line?: number
  column?: number
}

export function CodeEditor({
  value,
  onChange,
  onSubmit,
  error,
  minLines = 6,
  maxHeight = 480,
  testId,
  autoFocus = true,
  completion
}: {
  value: string
  onChange: (v: string) => void
  /** Receives the editor's current text (fresher than `value`, which updates after a render). */
  onSubmit?: (text: string) => void
  error?: EditorError | null
  minLines?: number
  maxHeight?: number
  testId?: string
  autoFocus?: boolean
  /** Context-aware completions and hover docs (mode + namespace for field names). */
  completion?: CompletionTarget
}) {
  const resolved = useThemeStore((s) => s.resolved)
  const editorRef = useRef<IEditor | null>(null)
  const submitRef = useRef(onSubmit)
  useEffect(() => {
    submitRef.current = onSubmit
  }, [onSubmit])

  const completionRef = useRef(completion)
  useEffect(() => {
    completionRef.current = completion
  }, [completion])
  const detachRef = useRef<() => void>(() => {})
  useEffect(() => () => detachRef.current(), [])

  const lines = Math.max(minLines, value.split('\n').length + 1)
  const height = Math.min(maxHeight, lines * 19 + 12)

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    if (!error) {
      monaco.editor.setModelMarkers(model, 'doc', [])
      return
    }
    const line = Math.min(error.line ?? 1, model.getLineCount())
    monaco.editor.setModelMarkers(model, 'doc', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        startLineNumber: line,
        startColumn: error.column ?? 1,
        endLineNumber: error.line ? line : model.getLineCount(),
        endColumn: model.getLineMaxColumn(error.line ? line : model.getLineCount())
      }
    ])
  }, [error, value])

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    if (completionRef.current)
      detachRef.current = attachCompletion(
        editor.getModel(),
        () => completionRef.current ?? { mode: 'document' }
      )
    const { KeyMod, KeyCode } = monaco
    // addAction (not addCommand): addCommand keybindings are global across editors.
    editor.addAction({
      id: 'studio.submit',
      label: 'Submit',
      keybindings: [KeyMod.CtrlCmd | KeyCode.Enter, KeyMod.CtrlCmd | KeyCode.KeyS],
      run: () => submitRef.current?.(editor.getValue())
    })
    if (autoFocus) editor.focus()
  }

  return (
    <div
      className={`overflow-hidden rounded-md border ${error ? 'border-destructive/70' : 'border-border'}`}
      data-testid={testId}
    >
      <Editor
        height={height}
        language={SHELL_LANGUAGE}
        theme={resolved === 'dark' ? 'studio-dark' : 'studio-light'}
        value={value}
        onChange={(v) => onChange(v ?? '')}
        onMount={onMount}
        options={{
          minimap: { enabled: false },
          lineNumbers: 'on',
          lineNumbersMinChars: 3,
          folding: true,
          scrollBeyondLastLine: false,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 19,
          tabSize: 2,
          automaticLayout: true,
          fixedOverflowWidgets: true,
          ...(completion
            ? completionEditorOptions
            : { quickSuggestions: false, wordBasedSuggestions: 'off' }),
          renderLineHighlight: 'none',
          stickyScroll: { enabled: false },
          padding: { top: 6, bottom: 6 }
        }}
      />
    </div>
  )
}

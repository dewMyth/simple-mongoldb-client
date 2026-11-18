/**
 * Monaco adapter for the shared completion engine (src/shared/autocomplete). Providers are
 * registered once for the shell language; each editor opts in by attaching its model with a
 * getter for its current mode and namespace.
 */
import { complete, hoverAt, type CompletionMode, type SuggestionKind } from '@shared/autocomplete/complete'
import { getFields } from './field-cache'
import { monaco, SHELL_LANGUAGE } from './monaco'

export interface CompletionTarget {
  mode: CompletionMode
  /** Field names come from a sample of this namespace (omit for operators only). */
  connectionId?: string
  ns?: string
  /** Mode 'stage': the stage operator being edited. */
  stage?: string
}

type Model = ReturnType<typeof monaco.editor.createModel>

const targets = new Map<string, () => CompletionTarget>()

/** Enables completions and hover docs for an editor's model. Returns a dispose function. */
export function attachCompletion(model: Model | null, get: () => CompletionTarget): () => void {
  if (!model) return () => {}
  ensureProviders()
  const k = model.uri.toString()
  targets.set(k, get)
  const t = get()
  if (t.connectionId && t.ns) void getFields(t.connectionId, t.ns) // warm the sample
  return () => {
    if (targets.get(k) === get) targets.delete(k)
  }
}

const K = monaco.languages.CompletionItemKind
const kinds: Record<SuggestionKind, number> = {
  field: K.Field,
  operator: K.Operator,
  stage: K.Module,
  accumulator: K.Function,
  expression: K.Function,
  constructor: K.Constructor,
  value: K.Value,
  variable: K.Variable,
  snippet: K.Snippet,
  option: K.Property
}

/** Editor options that turn on suggest-as-you-type for completion-enabled editors. */
export const completionEditorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  quickSuggestions: { other: true, comments: false, strings: true },
  suggestOnTriggerCharacters: true,
  wordBasedSuggestions: 'off',
  suggest: { showWords: false, insertMode: 'replace', showInlineDetails: true, preview: false },
  hover: { enabled: 'on', delay: 400 }
}

let registered = false

function ensureProviders() {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider(SHELL_LANGUAGE, {
    triggerCharacters: ['$', '.', '"', "'"],
    async provideCompletionItems(model, position) {
      const get = targets.get(model.uri.toString())
      if (!get) return { suggestions: [] }
      const target = get()
      const sample = target.connectionId && target.ns ? await getFields(target.connectionId, target.ns) : null
      if (model.isDisposed()) return { suggestions: [] }
      const text = model.getValue()
      const offset = model.getOffsetAt(position)
      const r = complete(text, offset, {
        mode: target.mode,
        fields: sample?.fields ?? [],
        stage: target.stage
      })
      const start = model.getPositionAt(r.replaceStart)
      const end = model.getPositionAt(Math.max(r.replaceEnd, offset))
      const insert = new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column)
      const replace = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
      return {
        suggestions: r.suggestions.map((s) => ({
          label: s.detail ? { label: s.label, description: s.detail } : s.label,
          kind: kinds[s.kind],
          insertText: s.insertText,
          insertTextRules: s.snippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          detail: s.detail,
          documentation: s.doc ? { value: s.doc } : undefined,
          sortText: s.sortText,
          filterText: s.filterText,
          range: { insert, replace }
        }))
      }
    }
  })

  monaco.languages.registerHoverProvider(SHELL_LANGUAGE, {
    provideHover(model, position) {
      if (!targets.has(model.uri.toString())) return null
      const h = hoverAt(model.getValue(), model.getOffsetAt(position))
      if (!h) return null
      const s = model.getPositionAt(h.start)
      const e = model.getPositionAt(h.end)
      return {
        range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column),
        contents: [{ value: h.markdown }]
      }
    }
  })
}

/**
 * Draft state for editing one document: immutable updates with undo/redo, and the diff against
 * the original (which drives the change count and highlights).
 */
import { useCallback, useMemo, useReducer } from 'react'
import type { Document } from 'bson'
import { diffDocuments, type DocDiff, type Path } from '@shared/doc-edit'

interface State {
  draft: Document
  past: Document[]
  future: Document[]
}

type Action = { type: 'apply'; fn: (d: Document) => Document } | { type: 'undo' } | { type: 'redo' }

const HISTORY_LIMIT = 200

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'apply': {
      const draft = action.fn(state.draft)
      if (draft === state.draft) return state
      return { draft, past: [...state.past, state.draft].slice(-HISTORY_LIMIT), future: [] }
    }
    case 'undo': {
      const prev = state.past.at(-1)
      if (!prev) return state
      return { draft: prev, past: state.past.slice(0, -1), future: [state.draft, ...state.future] }
    }
    case 'redo': {
      const [next, ...rest] = state.future
      if (!next) return state
      return { draft: next, past: [...state.past, state.draft], future: rest }
    }
  }
}

export const pathKey = (p: Path) => JSON.stringify(p)

export interface DocEditor {
  original: Document
  draft: Document
  diff: DocDiff
  changes: number
  /** Paths (as pathKey) that are new or changed, including everything under a replaced value. */
  isChanged: (path: Path) => boolean
  apply: (fn: (d: Document) => Document) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

export function useDocEditor(original: Document): DocEditor {
  const [state, dispatch] = useReducer(reducer, { draft: original, past: [], future: [] })
  const diff = useMemo(() => diffDocuments(original, state.draft), [original, state.draft])
  const changed = useMemo(() => diff.set.map(([p]) => p), [diff])
  const isChanged = useCallback(
    (path: Path) => changed.some((c) => c.length <= path.length && c.every((seg, i) => seg === path[i])),
    [changed]
  )
  return {
    original,
    draft: state.draft,
    diff,
    changes: diff.set.length + diff.unset.length,
    isChanged,
    apply: useCallback((fn) => dispatch({ type: 'apply', fn }), []),
    undo: useCallback(() => dispatch({ type: 'undo' }), []),
    redo: useCallback(() => dispatch({ type: 'redo' }), []),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0
  }
}

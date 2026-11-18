/**
 * Monaco is bundled locally (no CDN; the CSP forbids it). Language services load lazily, and the
 * query/pipeline editors use the Monarch JavaScript tokenizer only (shell syntax highlights as JS).
 * Only the base editor worker is wired up: we never open TS/JSON/CSS models.
 */
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

loader.config({ monaco })

export { monaco }

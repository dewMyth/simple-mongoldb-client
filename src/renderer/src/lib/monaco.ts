/**
 * Monaco is bundled locally (no CDN; the CSP forbids it). Only the base editor worker is wired:
 * query editors use the Monarch JavaScript tokenizer (shell syntax highlights as JS) and never
 * open TS/JSON/CSS models, so the heavy language workers never start.
 */
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'
import {
  conf as jsConf,
  language as jsLanguage
} from 'monaco-editor/languages/definitions/javascript/javascript.js'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

loader.config({ monaco })

/**
 * Query text is mongosh shell syntax. It gets its own language id so Monaco's TypeScript
 * service (which attaches to "javascript" and needs the TS worker) never runs on it; only the
 * Monarch JS tokenizer is reused for highlighting. Completions/hover come in Phase 7.
 */
export const SHELL_LANGUAGE = 'mongo-shell'
monaco.languages.register({ id: SHELL_LANGUAGE })
monaco.languages.setMonarchTokensProvider(SHELL_LANGUAGE, jsLanguage)
monaco.languages.setLanguageConfiguration(SHELL_LANGUAGE, jsConf)

monaco.editor.defineTheme('studio-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'string', foreground: '0b7a52' },
    { token: 'number', foreground: '1c5bd6' },
    { token: 'keyword', foreground: '8b3fd1' },
    { token: 'regexp', foreground: 'b4561b' }
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#00000000',
    'editorLineNumber.foreground': '#a0a8b4'
  }
})
monaco.editor.defineTheme('studio-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string', foreground: '5fd3a3' },
    { token: 'number', foreground: '79b8ff' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'regexp', foreground: 'f0a83a' }
  ],
  colors: {
    'editor.background': '#0b0f14',
    'editor.lineHighlightBackground': '#00000000',
    'editorLineNumber.foreground': '#4b5563'
  }
})

export { monaco }

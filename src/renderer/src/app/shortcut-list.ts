/** Keyboard shortcuts shown in Settings (keep in sync with shortcuts.ts and the editors). */
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
const mod = isMac ? '⌘' : 'Ctrl+'

export const SHORTCUTS: [string, string][] = [
  [`${mod}K`, 'Command palette: tabs, collections, recent queries, commands'],
  [`${mod}↵`, 'Run the query (Find) or save in an editor'],
  ['Esc', 'Cancel the running query'],
  [`${mod}⇧F`, 'Format the query'],
  ['↑ / ↓', 'Query history (first/last line of the filter); shell history'],
  ['Ctrl+Space', 'Show completions in an editor'],
  [`${mod}⇧T`, 'Reopen the last closed tab'],
  ['Ctrl+Tab / Ctrl+⇧Tab', 'Next / previous tab'],
  [`${mod}1 … ${mod}9`, 'Go to tab 1…8, 9 = last tab'],
  [`${mod},`, 'Settings'],
  [`${mod}Z / ${mod}⇧Z`, 'Undo / redo while editing a document'],
  [`${mod}S`, 'Save the document being edited'],
  ['Ctrl+C (shell)', 'Interrupt the running command'],
  ['Tab (shell)', 'Complete'],
  ['Ctrl+L (shell)', 'Clear the screen']
]

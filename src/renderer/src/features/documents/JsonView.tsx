/**
 * One syntax-coloured block per document, in shell syntax (types explicit: NumberLong, ISODate…).
 * Colouring uses Monaco's tokenizer so it matches the query editor. Big documents skip colouring
 * and are truncated until asked, so a 10 MB document never blocks the UI.
 */
import { memo, useEffect, useState } from 'react'
import type { Document } from 'bson'
import { Copy } from 'lucide-react'
import { stringifyCanonical, stringifyRelaxed } from '@shared/ejson'
import { receivedSize } from '@shared/bson-wire'
import { toShellPreview } from '@shared/shell-format'
import { monaco, SHELL_LANGUAGE } from '../../lib/monaco'
import { useThemeStore } from '../../stores/theme'
import { Button } from '../../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../components/ui/dropdown-menu'
import { copyText, shellText } from './bson-style'

/** Above this many characters, skip colouring (tokenizing is synchronous work). */
const COLORIZE_LIMIT = 200_000
/** Characters shown for a large document until the user asks for everything. */
const PREVIEW_LIMIT = 100_000
/** Documents over this BSON size are previewed instead of fully formatted up front. */
const LARGE_BYTES = 1_048_576

const htmlCache = new WeakMap<object, { theme: string; html: string }>()
const previewCache = new WeakMap<object, { text: string; truncated: boolean }>()

/** Full text for normal documents; a bounded preview for large ones (cheap to build). */
function displayText(doc: Document): { text: string; truncated: boolean } {
  if ((receivedSize(doc) ?? 0) <= LARGE_BYTES) {
    const text = shellText(doc)
    return text.length > PREVIEW_LIMIT
      ? { text: text.slice(0, PREVIEW_LIMIT), truncated: true }
      : { text, truncated: false }
  }
  let p = previewCache.get(doc)
  if (!p) {
    p = toShellPreview(doc, PREVIEW_LIMIT)
    previewCache.set(doc, p)
  }
  return p
}

export const JsonView = memo(function JsonView({ doc }: { doc: Document }) {
  const theme = useThemeStore((s) => s.resolved)
  const [showAll, setShowAll] = useState(false)
  const preview = displayText(doc)
  // The full text of a huge document is only built when asked for.
  const text = showAll && preview.truncated ? shellText(doc) : preview.text
  const truncated = preview.truncated
  // Coloured HTML is cached per document+theme; the effect only fills the cache.
  const cached = htmlCache.get(doc)
  const html = cached?.theme === theme && !truncated ? cached.html : null
  const [, setColorized] = useState(0)

  useEffect(() => {
    if (html !== null || truncated || text.length > COLORIZE_LIMIT) return
    let cancelled = false
    monaco.editor.setTheme(theme === 'dark' ? 'studio-dark' : 'studio-light')
    void monaco.editor.colorize(text, SHELL_LANGUAGE, { tabSize: 2 }).then((out) => {
      htmlCache.set(doc, { theme, html: out })
      if (!cancelled) setColorized((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [doc, text, theme, html, truncated])

  const size = receivedSize(doc)
  return (
    <div className="group/doc relative rounded-md border bg-card" data-testid="doc">
      <div className="absolute top-1 right-1 z-10 opacity-0 transition-opacity group-hover/doc:opacity-100">
        <CopyMenu doc={doc} />
      </div>
      {html ? (
        // Monaco's colorizer escapes the text and only emits <span class="mtkN"> wrappers.
        <div
          className="selectable overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="selectable overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre">
          {text}
        </pre>
      )}
      {truncated && (
        <div
          className="flex items-center gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="large-doc-note"
        >
          Large document{size ? ` (${(size / 1_048_576).toFixed(1)} MB)` : ''}
          {showAll
            ? ', shown in full without colouring.'
            : `: showing the first ${PREVIEW_LIMIT / 1000} KB of text.`}
          <button type="button" className="text-primary hover:underline" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show less' : 'Show all (may take a moment)'}
          </button>
        </div>
      )}
    </div>
  )
})

/** Copy a whole document in the formats people paste into other tools. */
export function CopyMenu({ doc }: { doc: Document }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Copy document" data-testid="copy-doc">
          <Copy />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="text-xs">
        <DropdownMenuItem onSelect={() => copyText(shellText(doc))}>Copy as shell syntax</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copyText(stringifyCanonical(doc, 2))}>
          Copy as canonical EJSON
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copyText(stringifyRelaxed(doc, 2))}>
          Copy as relaxed JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

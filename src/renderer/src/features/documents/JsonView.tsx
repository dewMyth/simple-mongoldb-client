/**
 * One syntax-coloured block per document, in shell syntax (types explicit: NumberLong, ISODate…).
 * Colouring uses Monaco's tokenizer so it matches the query editor. Big documents skip colouring
 * and are truncated until asked, so a 10 MB document never blocks the UI.
 */
import { memo, useEffect, useState } from 'react'
import type { Document } from 'bson'
import { Copy } from 'lucide-react'
import { stringifyCanonical, stringifyRelaxed } from '@shared/ejson'
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
/** Above this many characters, show a prefix until the user asks for everything. */
const PREVIEW_LIMIT = 100_000

const htmlCache = new WeakMap<object, { theme: string; html: string }>()

export const JsonView = memo(function JsonView({ doc }: { doc: Document }) {
  const theme = useThemeStore((s) => s.resolved)
  const text = shellText(doc)
  const big = text.length > PREVIEW_LIMIT
  const [showAll, setShowAll] = useState(false)
  // Coloured HTML is cached per document+theme; the effect only fills the cache.
  const cached = htmlCache.get(doc)
  const html = cached?.theme === theme ? cached.html : null
  const [, setColorized] = useState(0)

  useEffect(() => {
    if (html !== null || text.length > COLORIZE_LIMIT) return
    let cancelled = false
    monaco.editor.setTheme(theme === 'dark' ? 'studio-dark' : 'studio-light')
    void monaco.editor.colorize(text, SHELL_LANGUAGE, { tabSize: 2 }).then((out) => {
      htmlCache.set(doc, { theme, html: out })
      if (!cancelled) setColorized((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [doc, text, theme, html])

  return (
    <div className="group/doc relative rounded-md border bg-card" data-testid="doc">
      <div className="absolute top-1 right-1 z-10 opacity-0 transition-opacity group-hover/doc:opacity-100">
        <CopyMenu doc={doc} />
      </div>
      {html && !big ? (
        // Monaco's colorizer escapes the text and only emits <span class="mtkN"> wrappers.
        <div
          className="selectable overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="selectable overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre">
          {big && !showAll ? text.slice(0, PREVIEW_LIMIT) : text}
        </pre>
      )}
      {big && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
          Large document ({(text.length / 1_048_576).toFixed(1)} MB of text)
          {showAll ? ', shown in full without colouring.' : `, showing the first ${PREVIEW_LIMIT / 1000} KB.`}
          <button type="button" className="text-primary hover:underline" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show less' : 'Show all'}
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

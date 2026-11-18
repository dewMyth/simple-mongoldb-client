/**
 * "Export to code": the current query or pipeline as runnable driver code in six languages. Code is
 * generated in main (where the query parser lives); the connection string is always read from
 * MONGODB_URI, so no credentials ever appear in the output.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'
import {
  exportLanguageLabel,
  exportLanguages,
  type ExportLanguage,
  type ExportMode
} from '@shared/code-export'
import type { QueryText } from '@shared/query'
import type { PipelineOptions, StageInput } from '@shared/pipeline'
import { Dialog } from '../../components/Dialog'
import { Button } from '../../components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group'
import { ipc } from '../../lib/ipc'
import { monaco, SHELL_LANGUAGE } from '../../lib/monaco'
import { useThemeStore } from '../../stores/theme'

const monacoLanguage: Record<ExportLanguage, string> = {
  node: SHELL_LANGUAGE, // JS tokenizer without the TS worker
  python: 'python',
  java: 'java',
  csharp: 'csharp',
  go: 'go',
  shell: SHELL_LANGUAGE
}

const LANG_KEY = 'export-code.language'
function initialLanguage(): ExportLanguage {
  try {
    const v = localStorage.getItem(LANG_KEY) as ExportLanguage | null
    if (v && exportLanguages.includes(v)) return v
  } catch {
    /* storage unavailable */
  }
  return 'node'
}

export type ExportSource =
  { kind: 'query'; query: QueryText } | { kind: 'aggregate'; stages: StageInput[]; options: PipelineOptions }

export function ExportCodeDialog({
  ns,
  source,
  onClose
}: {
  ns: string
  source: ExportSource
  onClose: () => void
}) {
  const [language, setLanguage] = useState<ExportLanguage>(initialLanguage)
  const [mode, setMode] = useState<ExportMode>('find')
  const [copied, setCopied] = useState(false)
  const theme = useThemeStore((s) => s.resolved)

  const { data, error } = useQuery({
    queryKey: ['exportCode', ns, source, language, mode],
    queryFn: async (): Promise<{ ok: true; code: string } | { ok: false; message: string }> => {
      if (source.kind === 'aggregate')
        return ipc('agg:exportCode', { ns, stages: source.stages, options: source.options, language })
      const r = await ipc('query:exportCode', { ns, query: source.query, language, mode })
      return r.ok
        ? r
        : {
            ok: false,
            message: `Fix the query first: ${r.errors.map((e) => `${e.field}: ${e.message}`).join(' · ')}`
          }
    }
  })
  const code = data?.ok ? data.code : null

  // Coloured HTML, tagged with the code+theme it was made from (stale results are ignored).
  const [colored, setColored] = useState<{ key: string; html: string } | null>(null)
  const colorKey = `${theme}\u0000${code}`
  const html = colored?.key === colorKey ? colored.html : null
  useEffect(() => {
    if (!code) return
    let cancelled = false
    monaco.editor.setTheme(theme === 'dark' ? 'studio-dark' : 'studio-light')
    void monaco.editor.colorize(code, monacoLanguage[language], { tabSize: 4 }).then((out) => {
      if (!cancelled) setColored({ key: `${theme}\u0000${code}`, html: out })
    })
    return () => {
      cancelled = true
    }
  }, [code, language, theme])

  const pick = (l: string) => {
    if (!l) return
    setLanguage(l as ExportLanguage)
    try {
      localStorage.setItem(LANG_KEY, l)
    } catch {
      /* storage unavailable */
    }
  }

  const copy = () => {
    if (!code) return
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={source.kind === 'query' ? 'Export query to code' : 'Export pipeline to code'}
      description={`${ns} · the connection string is read from MONGODB_URI`}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={copy} disabled={!code} data-testid="export-copy">
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup type="single" variant="outline" size="sm" value={language} onValueChange={pick}>
          {exportLanguages.map((l) => (
            <ToggleGroupItem key={l} value={l} className="px-2.5 text-xs" data-testid={`export-lang-${l}`}>
              {exportLanguageLabel[l]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {source.kind === 'query' && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={mode}
            onValueChange={(m) => m && setMode(m as ExportMode)}
          >
            <ToggleGroupItem value="find" className="px-2.5 text-xs">
              Find
            </ToggleGroupItem>
            <ToggleGroupItem value="count" className="px-2.5 text-xs" data-testid="export-mode-count">
              Count
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      {error ? (
        <div className="text-xs text-destructive">{(error as Error).message}</div>
      ) : data && !data.ok ? (
        <div className="text-xs text-destructive" data-testid="export-errors">
          {data.message}
        </div>
      ) : (
        <div className="rounded-md border bg-card">
          {html ? (
            // Monaco's colorizer escapes the text and only emits <span class="mtkN"> wrappers.
            <div
              className="selectable overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre"
              dangerouslySetInnerHTML={{ __html: html }}
              data-testid="export-code"
            />
          ) : (
            <pre
              className="selectable overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre"
              data-testid="export-code"
            >
              {code ?? ''}
            </pre>
          )}
        </div>
      )}
    </Dialog>
  )
}

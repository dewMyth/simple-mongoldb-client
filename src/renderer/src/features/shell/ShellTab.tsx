/**
 * Shell tab: an xterm.js terminal on top of the real mongosh runtime (in main). The session
 * lives in main for as long as the tab is open, so switching tabs keeps it (and the transcript
 * is replayed); closing the tab ends it.
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Eraser, Lock, RotateCcw, Square } from 'lucide-react'
import { ansi } from '@shared/shell-output'
import type { Tab } from '../../stores/tabs'
import { ipc } from '../../lib/ipc'
import { useThemeStore } from '../../stores/theme'
import { currentSettings, useSettingsStore } from '../../stores/settings'
import { useSavedConnections } from '../connections/queries'
import { Button } from '../../components/ui/button'
import { LineEditor } from './line-editor'

/** Terminal text per tab, replayed when the tab is shown again (capped). */
const transcripts = new Map<string, string>()
const TRANSCRIPT_LIMIT = 1_000_000

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')

const historyKey = (connectionId: string) => `shell-history:${connectionId}`
function loadHistory(connectionId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(historyKey(connectionId)) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function saveHistory(connectionId: string, history: string[]) {
  try {
    localStorage.setItem(historyKey(connectionId), JSON.stringify(history.slice(-500)))
  } catch {
    /* storage unavailable */
  }
}

const themes = {
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f2328',
    selectionBackground: '#b4d5fe',
    green: '#0b7a52',
    yellow: '#9a6700',
    cyan: '#1b7c83',
    magenta: '#8b3fd1',
    blue: '#1c5bd6',
    red: '#cf222e'
  },
  dark: {
    background: '#0b0f14',
    foreground: '#d6dde6',
    cursor: '#d6dde6',
    selectionBackground: '#264f78',
    green: '#5fd3a3',
    yellow: '#e3b341',
    cyan: '#56d4dd',
    magenta: '#c792ea',
    blue: '#79b8ff',
    red: '#ff7b72'
  }
}

export function ShellTab({ tab }: { tab: Tab }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const sessionRef = useRef<string | null>(null)
  const editorRef = useRef<LineEditor | null>(null)
  const [readOnly, setReadOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restartKey, setRestartKey] = useState(0)
  // The last command's output as plain text: announced to screen readers (and read by tests).
  const [last, setLast] = useState<{ runs: number; text: string }>({ runs: 0, text: '' })
  const theme = useThemeStore((s) => s.resolved)
  const { data: saved = [] } = useSavedConnections()
  const connName = saved.find((c) => c.id === tab.connectionId)?.name ?? 'connection'
  const connNameRef = useRef(connName)
  useEffect(() => {
    connNameRef.current = connName
  }, [connName])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: currentSettings().fontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10_000,
      convertEol: false,
      theme: themes[useThemeStore.getState().resolved === 'dark' ? 'dark' : 'light']
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    let disposed = false

    const record = (data: string) => {
      const t = (transcripts.get(tab.id) ?? '') + data
      transcripts.set(tab.id, t.length > TRANSCRIPT_LIMIT ? t.slice(t.length - TRANSCRIPT_LIMIT) : t)
    }
    const write = (data: string) => {
      record(data)
      term.write(data)
    }
    const previous = transcripts.get(tab.id)
    if (previous) term.write(previous)

    const editor = new LineEditor(
      {
        write,
        get cols() {
          return term.cols
        }
      },
      {
        run: async (code) => {
          const sessionId = sessionRef.current
          if (!sessionId) return
          setBusy(true)
          try {
            const r = await ipc('shell:evaluate', { sessionId, code })
            if (r.output) write(r.output.replace(/\r?\n/g, '\r\n') + '\r\n')
            editor.setPrompt(r.prompt)
            setReadOnly(r.readOnly)
            setLast((l) => ({ runs: l.runs + 1, text: stripAnsi(r.output) }))
          } catch (e) {
            write(ansi.red((e as Error).message) + '\r\n')
            setLast((l) => ({ runs: l.runs + 1, text: (e as Error).message }))
          } finally {
            setBusy(false)
          }
        },
        interrupt: () => {
          const sessionId = sessionRef.current
          if (sessionId) void ipc('shell:interrupt', sessionId).catch(() => {})
        },
        complete: (code) => {
          const sessionId = sessionRef.current
          return sessionId ? ipc('shell:complete', { sessionId, code }).catch(() => []) : Promise.resolve([])
        },
        onHistory: (h) => saveHistory(tab.connectionId, h)
      },
      loadHistory(tab.connectionId)
    )
    editorRef.current = editor

    // Output printed while a command runs (print(), console.log…).
    const offOutput = window.api.on('shell:output', ({ sessionId, text }) => {
      if (sessionId === sessionRef.current) write(text.replace(/\r?\n/g, '\r\n') + '\r\n')
    })
    const onData = term.onData((d) => void editor.handle(d))
    // Copy with Cmd/Ctrl+C when text is selected (Ctrl+C otherwise interrupts); Ctrl+Shift+C too.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const copy =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && (term.hasSelection() || e.shiftKey)
      if (copy) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      return true
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* hidden */
      }
    })
    ro.observe(host)

    if (!previous) write(ansi.dim(`Connecting the shell to ${connNameRef.current}…`) + '\r\n')
    ipc('shell:start', {
      connectionId: tab.connectionId,
      tabId: tab.id,
      db: tab.ns && !tab.ns.includes('.') ? tab.ns : null
    })
      .then((info) => {
        if (disposed) return
        sessionRef.current = info.sessionId
        setReadOnly(info.readOnly)
        editor.setPrompt(info.prompt)
        if (!info.resumed) {
          write(
            `${ansi.bold('mongosh')} ${ansi.dim('(the real mongosh runtime) · Tab completes · Ctrl+C interrupts · ↑/↓ history')}\r\n`
          )
          if (info.readOnly)
            write(
              ansi.yellow(
                'Read-only mode: write commands are refused. This guards against accidents; it is not a security boundary.'
              ) + '\r\n'
            )
        }
        // A replayed transcript ends with the old prompt line: replace it.
        if (previous) term.write('\r\u001b[2K')
        editor.showPrompt()
        term.focus()
      })
      .catch((e: Error) => !disposed && write(ansi.red(e.message) + '\r\n'))

    return () => {
      disposed = true
      offOutput()
      onData.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      // The session stays alive in main until the tab is closed (ops:cancelForTab ends it).
    }
  }, [tab.id, tab.connectionId, tab.ns, restartKey])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themes[theme === 'dark' ? 'dark' : 'light']
  }, [theme])
  const fontSize = useSettingsStore((s) => s.settings.fontSize)
  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = fontSize
  }, [fontSize])

  const restart = async () => {
    const sessionId = sessionRef.current
    sessionRef.current = null
    if (sessionId) await ipc('shell:close', sessionId).catch(() => {})
    transcripts.delete(tab.id)
    setRestartKey((k) => k + 1)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="shell-tab">
      <div className="flex items-center gap-2 border-b bg-panel px-3 py-1.5 text-xs">
        <span className="font-medium">Shell</span>
        <span className="text-muted-foreground">
          {connName}
          {tab.ns ? ` · ${tab.ns}` : ''}
        </span>
        {readOnly && (
          <span
            className="flex items-center gap-1 rounded bg-warn/15 px-1.5 py-px text-[10px] font-medium text-warn"
            title="Write methods are replaced with ones that refuse, to prevent accidents. Determined code can still reach the driver, so this isn't a security boundary: use a read-only database user for that."
            data-testid="shell-readonly"
          >
            <Lock size={10} /> Read-only (guard against accidents)
          </span>
        )}
        <span className="flex-1" />
        {busy && (
          <Button
            size="sm"
            variant="outline"
            className="h-6"
            onClick={() => void editorRef.current?.handle('\u0003')}
            data-testid="shell-interrupt"
          >
            <Square size={10} /> Interrupt (Ctrl+C)
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6"
          onClick={() => termRef.current?.clear()}
          title="Clear the screen (Ctrl+L)"
        >
          <Eraser /> Clear
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6"
          onClick={() => void restart()}
          title="End this session and start a new one"
        >
          <RotateCcw /> Restart
        </Button>
      </div>
      <div
        className="min-h-0 flex-1 p-2"
        style={{ background: themes[theme === 'dark' ? 'dark' : 'light'].background }}
      >
        <div ref={hostRef} className="h-full w-full" data-testid="shell-terminal" />
      </div>
      <div className="sr-only" aria-live="polite" data-testid="shell-last-output" data-runs={last.runs}>
        {last.text}
      </div>
    </div>
  )
}

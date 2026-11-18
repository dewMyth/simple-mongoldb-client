/**
 * Formats mongosh evaluation results for the terminal, close to what mongosh prints: documents
 * in shell syntax (ObjectId('…'), NumberLong('…')…), cursor batches with 'Type "it" for more',
 * `show dbs` / `show collections` tables, help. Optional ANSI colours for xterm.
 */
import { toShellString } from './shell-format'

const ESC = '\u001b['
export const ansi = {
  reset: `${ESC}0m`,
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  red: (s: string) => `${ESC}31m${s}${ESC}39m`,
  green: (s: string) => `${ESC}32m${s}${ESC}39m`,
  yellow: (s: string) => `${ESC}33m${s}${ESC}39m`,
  blue: (s: string) => `${ESC}34m${s}${ESC}39m`,
  magenta: (s: string) => `${ESC}35m${s}${ESC}39m`,
  cyan: (s: string) => `${ESC}36m${s}${ESC}39m`,
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`
}

const TOKENS =
  /("(?:[^"\\]|\\.)*")|\b(ObjectId|ISODate|NumberLong|NumberInt|NumberDecimal|Double|Timestamp|BinData|UUID|MinKey|MaxKey|RegExp|Code|DBRef|Symbol)(?=\()|(?<![\w$.])(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?![\w$])|\b(true|false|null|undefined)\b/g

/** Colours shell-syntax text: strings green, BSON constructors cyan, numbers yellow. */
export function colorize(text: string): string {
  return text.replace(TOKENS, (m, str: string, ctor: string, num: string, kw: string) => {
    if (str) return ansi.green(m)
    if (ctor) return ansi.cyan(m)
    if (num) return ansi.yellow(m)
    if (kw) return ansi.magenta(m)
    return m
  })
}

type Printable = unknown
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

function value(v: unknown, color: boolean): string {
  if (typeof v === 'string') return v
  if (v === undefined) return ''
  const text = toShellString(v, 2)
  return color ? colorize(text) : text
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(2)} ${units[i]}`
}

const CURSOR_TYPES = new Set([
  'Cursor',
  'AggregationCursor',
  'CursorIterationResult',
  'RunCommandCursor',
  'ChangeStreamCursor',
  'ExplainableCursor'
])

/** Text for one evaluation result ('' when mongosh would print nothing). */
export function formatShellResult(
  type: string | null | undefined,
  printable: Printable,
  color = true
): string {
  const c = color ? ansi : { ...ansi, dim: (s: string) => s, red: (s: string) => s, bold: (s: string) => s }
  if (type && CURSOR_TYPES.has(type) && isObj(printable) && Array.isArray(printable.documents)) {
    const docs = printable.documents as unknown[]
    if (!docs.length) return type === 'CursorIterationResult' ? c.dim('no cursor') : ''
    const body = value(docs, color)
    return printable.cursorHasMore ? `${body}\n${c.dim('Type "it" for more')}` : body
  }
  switch (type) {
    case 'InspectResult':
      return String(printable)
    case 'SerializedErrorResult': {
      const e = printable as { name?: string; message?: string }
      return c.red(`${e.name ?? 'Error'}: ${e.message ?? ''}`)
    }
    case 'ShowDatabasesResult': {
      const rows = (Array.isArray(printable) ? printable : []) as { name: string; sizeOnDisk?: unknown }[]
      const width = Math.max(0, ...rows.map((r) => r.name.length))
      return rows
        .map(
          (r) =>
            `${r.name.padEnd(width + 2)}${r.sizeOnDisk === undefined ? '' : formatBytes(Number(String(r.sizeOnDisk)))}`
        )
        .join('\n')
    }
    case 'ShowCollectionsResult': {
      const rows = (Array.isArray(printable) ? printable : []) as { name: string; badge?: string }[]
      return rows.map((r) => `${r.name}${r.badge ? ` ${c.dim(r.badge)}` : ''}`).join('\n')
    }
    case 'Help': {
      const h = printable as {
        help?: string
        docs?: string
        attr?: { name?: string; description?: string }[]
      }
      const lines: string[] = []
      if (h.help) lines.push(c.bold(h.help))
      const attrs = h.attr ?? []
      const width = Math.max(0, ...attrs.map((a) => (a.name ?? '').length))
      for (const a of attrs) lines.push(`  ${(a.name ?? '').padEnd(width + 2)}${a.description ?? ''}`)
      if (h.docs) lines.push('', `For more information: ${h.docs}`)
      return lines.join('\n')
    }
    case 'StatsResult':
      return isObj(printable)
        ? Object.entries(printable)
            .map(([k, v]) => `${c.bold(k)}\n${value(v, color)}`)
            .join('\n---\n')
        : value(printable, color)
  }
  if (printable === undefined) return ''
  if (typeof printable === 'string') return printable
  return value(printable, color)
}

export function formatShellError(
  err: { name?: string; message?: string; code?: unknown },
  color = true
): string {
  const name = err.name && err.name !== 'Error' ? err.name : 'Error'
  const code = err.code !== undefined && typeof err.code !== 'object' ? `[${String(err.code)}] ` : ''
  const text = `${name}: ${code}${err.message ?? ''}`
  return color ? ansi.red(text) : text
}

/**
 * Whether typed input is unfinished (open brackets, strings or a trailing operator), so Enter
 * should continue on a new line instead of running it.
 */
export function isIncompleteInput(code: string): boolean {
  let depth = 0
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    if (ch === '/' && code[i + 1] === '/') {
      const e = code.indexOf('\n', i)
      if (e === -1) break
      i = e
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      const e = code.indexOf('*/', i + 2)
      if (e === -1) return true
      i = e + 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      for (; j < code.length; j++) {
        if (code[j] === '\\') j++
        else if (code[j] === ch) break
        else if (code[j] === '\n' && ch !== '`') return false // unterminated string: let the parser report it
      }
      if (j >= code.length) return ch === '`'
      i = j
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
  }
  if (depth > 0) return true
  return /[.,(+\-*/=&|?:]\s*$/.test(code.trim()) && !/\+\+$|--$/.test(code.trim())
}

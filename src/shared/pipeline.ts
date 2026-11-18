/**
 * Aggregation pipeline model and the text ↔ stages conversion used by the builder.
 *
 * Stage mode keeps each stage as { operator, body } where `body` is the user's own shell-syntax
 * text, so switching modes never reformats anything:
 *   - stagesToText writes `[ { $op: body }, … ]`, indenting multi-line bodies; disabled stages
 *     become `// ` comment lines.
 *   - textToStages scans the array (strings, regexes and comments aware), slices each stage's
 *     body back out, removes the indentation stagesToText added and turns commented-out stages
 *     back into disabled ones. Other top-level comments are dropped.
 */
import { z } from 'zod'
import type { BsonBytes } from './bson-wire'

export interface PipelineStage {
  id: string
  operator: string
  body: string
  enabled: boolean
}

export interface PipelineOptions {
  allowDiskUse: boolean
  /** Text, like the query bar (validated in main). */
  maxTimeMS: string
  collation: string
  comment: string
}

export interface PipelineState {
  mode: 'stages' | 'text'
  /** Text mode's text (kept while in text mode; regenerated when switching to it). */
  text: string
  stages: PipelineStage[]
  options: PipelineOptions
  /** Documents shown per stage preview. */
  sampleSize: number
  autoPreview: boolean
}

/** Stages that write to a collection: never run during preview. */
export const WRITE_STAGES = ['$out', '$merge'] as const
/** Atlas Search stages (need Atlas or a local Atlas deployment). */
export const ATLAS_STAGES = ['$search', '$searchMeta', '$vectorSearch'] as const

export const isWriteStage = (op: string) => (WRITE_STAGES as readonly string[]).includes(op)
export const isAtlasStage = (op: string) => (ATLAS_STAGES as readonly string[]).includes(op)

export const OPERATOR_RE = /^\$[A-Za-z][A-Za-z0-9]*$/

export const DEFAULT_SAMPLE_SIZE = 20

export const pipelineStageSchema = z.object({
  id: z.string().min(1).max(100),
  operator: z.string().max(100),
  body: z.string().max(1_000_000),
  enabled: z.boolean()
})

export const pipelineOptionsSchema = z.object({
  allowDiskUse: z.boolean(),
  maxTimeMS: z.string().max(20),
  collation: z.string().max(10_000),
  comment: z.string().max(10_000)
})

export const pipelineStateSchema = z.object({
  mode: z.enum(['stages', 'text']),
  text: z.string().max(2_000_000),
  stages: z.array(pipelineStageSchema).max(500),
  options: pipelineOptionsSchema,
  sampleSize: z.number().int().min(1).max(1000),
  autoPreview: z.boolean()
})

/** What main needs to run stages: operator + body text, in order (enabled stages only). */
export const stageInputSchema = z.object({ operator: z.string().max(100), body: z.string().max(1_000_000) })
export type StageInput = z.infer<typeof stageInputSchema>

export const emptyPipelineOptions: PipelineOptions = {
  allowDiskUse: false,
  maxTimeMS: '',
  collation: '',
  comment: ''
}

let counter = 0
export const newStageId = () => `stage-${Date.now().toString(36)}-${(counter++).toString(36)}`

export function newPipelineState(): PipelineState {
  return {
    mode: 'stages',
    text: '',
    stages: [{ id: newStageId(), operator: '$match', body: '{}', enabled: true }],
    options: emptyPipelineOptions,
    sampleSize: DEFAULT_SAMPLE_SIZE,
    autoPreview: true
  }
}

// ---------------------------------------------------------------- stages → text

const INDENT = '  '

/** Indents every line after the first. */
const indentRest = (text: string, pad: string) => text.replace(/\n/g, `\n${pad}`)

export function stagesToText(stages: Pick<PipelineStage, 'operator' | 'body' | 'enabled'>[]): string {
  if (!stages.length) return '[]'
  const lines: string[] = []
  stages.forEach((s, i) => {
    const elem = `${INDENT}{ ${s.operator}:${s.body ? ' ' + indentRest(s.body, INDENT) : ''} }`
    if (!s.enabled) {
      for (const l of elem.split('\n')) lines.push(`${INDENT}// ${l.slice(INDENT.length)}`)
      return
    }
    const more = stages.slice(i + 1).some((n) => n.enabled)
    lines.push(elem + (more ? ',' : ''))
  })
  return `[\n${lines.join('\n')}\n]`
}

// ---------------------------------------------------------------- text → stages

export type TextToStagesResult =
  { ok: true; stages: Omit<PipelineStage, 'id'>[] } | { ok: false; error: string; line?: number }

interface Piece {
  kind: 'element' | 'comment'
  start: number
  end: number
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length

/** Skips a string literal starting at `i` (the quote); returns the index after it, or -1. */
function skipString(text: string, i: number): number {
  const q = text[i]
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++
    else if (text[j] === q) return j + 1
    else if (text[j] === '\n' && q !== '`') return -1
  }
  return -1
}

/** Skips a regex literal starting at `i` (the slash); returns the index after its flags, or -1. */
function skipRegex(text: string, i: number): number {
  let inClass = false
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]
    if (c === '\\') j++
    else if (c === '\n') return -1
    else if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      let k = j + 1
      while (k < text.length && /[a-z]/i.test(text[k]!)) k++
      return k
    }
  }
  return -1
}

/**
 * Splits the top-level array into element and comment pieces. Returns an error message for
 * unbalanced brackets or unterminated strings.
 */
function scanArray(text: string): { pieces: Piece[] } | { error: string; line?: number } {
  let i = 0
  // Skip leading whitespace and comments.
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (text.startsWith('//', i)) i = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i)
    else if (text.startsWith('/*', i)) {
      const e = text.indexOf('*/', i + 2)
      if (e === -1) return { error: 'Unterminated comment' }
      i = e + 2
    } else break
  }
  if (text[i] !== '[')
    return {
      error: 'The pipeline must be an array of stages: [ { $match: { … } }, … ]',
      line: lineOf(text, i)
    }
  i++
  const pieces: Piece[] = []
  let depth = 1
  let elemStart = -1
  let lastSig = '['
  const endElement = (at: number) => {
    if (elemStart >= 0) pieces.push({ kind: 'element', start: elemStart, end: at })
    elemStart = -1
  }
  while (i < text.length) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i)
      const end = e === -1 ? text.length : e
      if (depth === 1) {
        // At depth 1 any element in progress is complete (its braces closed): end it here.
        endElement(i)
        pieces.push({ kind: 'comment', start: i + 2, end })
      }
      i = end
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2)
      if (e === -1) return { error: 'Unterminated comment', line: lineOf(text, i) }
      i = e + 2
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (depth === 1 && elemStart < 0 && c !== ',' && c !== ']') elemStart = i
    if (c === '"' || c === "'" || c === '`') {
      const e = skipString(text, i)
      if (e < 0) return { error: 'Unterminated string', line: lineOf(text, i) }
      i = e
      lastSig = 'v'
      continue
    }
    if (c === '/' && /[:[,({]/.test(lastSig)) {
      const e = skipRegex(text, i)
      if (e < 0) return { error: 'Unterminated regular expression', line: lineOf(text, i) }
      i = e
      lastSig = 'v'
      continue
    }
    if (c === '[' || c === '{' || c === '(') depth++
    else if (c === ']' || c === '}' || c === ')') {
      depth--
      if (depth === 0) {
        endElement(i)
        const rest = text.slice(i + 1).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
        if (rest.trim())
          return { error: 'Unexpected text after the pipeline array', line: lineOf(text, i + 1) }
        return { pieces }
      }
    } else if (c === ',' && depth === 1) endElement(i)
    lastSig = c
    i++
  }
  return { error: 'The pipeline array is not closed: missing "]"', line: lineOf(text, text.length) }
}

/** Parses one `{ $op: body }` element. */
function parseElement(
  text: string,
  start: number,
  end: number
): { operator: string; body: string } | { error: string } {
  const src = text.slice(start, end).trimEnd()
  if (!src.startsWith('{') || !src.endsWith('}'))
    return { error: 'Each stage must be an object with one operator, like { $match: { … } }' }
  let i = 1
  while (i < src.length && /\s/.test(src[i]!)) i++
  let key: string
  if (src[i] === '"' || src[i] === "'") {
    const e = skipString(src, i)
    if (e < 0) return { error: 'Unterminated string' }
    key = src.slice(i + 1, e - 1)
    i = e
  } else {
    const m = /^[$\w]+/.exec(src.slice(i))
    if (!m) return { error: 'Each stage must start with its operator, like { $match: … }' }
    key = m[0]
    i += key.length
  }
  while (i < src.length && /\s/.test(src[i]!)) i++
  if (src[i] !== ':') return { error: `Expected ":" after ${key}` }
  i++
  // Body: up to the element's closing brace; it must not contain a second top-level key.
  let bodyEnd = src.length - 1
  let depth = 0
  let lastSig = ':'
  for (let j = i; j < bodyEnd; j++) {
    const c = src[j]!
    if (c === '"' || c === "'" || c === '`') {
      const e = skipString(src, j)
      if (e < 0) return { error: 'Unterminated string' }
      j = e - 1
      lastSig = 'v'
      continue
    }
    if (c === '/' && src[j + 1] === '/') {
      j = src.indexOf('\n', j) === -1 ? bodyEnd : src.indexOf('\n', j) - 1
      continue
    }
    if (c === '/' && src[j + 1] === '*') {
      const e = src.indexOf('*/', j + 2)
      j = e === -1 ? bodyEnd : e + 1
      continue
    }
    if (c === '/' && /[:[,({]/.test(lastSig)) {
      const e = skipRegex(src, j)
      if (e < 0) return { error: 'Unterminated regular expression' }
      j = e - 1
      lastSig = 'v'
      continue
    }
    if (/\s/.test(c)) continue
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (c === ',' && depth === 0) {
      if (src.slice(j + 1, bodyEnd).trim())
        return { error: `A stage can only have one operator (found more after ${key})` }
      bodyEnd = j // trailing comma
      break
    }
    lastSig = c
  }
  // Remove the indentation stagesToText added (the element's own column).
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const column = start - lineStart
  const raw = src.slice(i, bodyEnd).trim()
  const pad = new RegExp(`\\n {0,${column}}`, 'g')
  return { operator: key, body: column ? raw.replace(pad, '\n') : raw }
}

export function textToStages(text: string): TextToStagesResult {
  if (!text.trim()) return { ok: true, stages: [] }
  const scanned = scanArray(text)
  if ('error' in scanned) return { ok: false, error: scanned.error, line: scanned.line }
  const stages: Omit<PipelineStage, 'id'>[] = []
  const { pieces } = scanned
  for (let p = 0; p < pieces.length; p++) {
    const piece = pieces[p]!
    if (piece.kind === 'element') {
      const r = parseElement(text, piece.start, piece.end)
      if ('error' in r)
        return { ok: false, error: `Stage ${stages.length + 1}: ${r.error}`, line: lineOf(text, piece.start) }
      stages.push({ ...r, enabled: true })
      continue
    }
    // A run of comment lines: if it holds stages, they are disabled stages.
    const run: Piece[] = [piece]
    while (pieces[p + 1]?.kind === 'comment') run.push(pieces[++p]!)
    const inner = run.map((c) => text.slice(c.start, c.end).replace(/^ /, '')).join('\n')
    const parsed = textToStages(`[\n${inner}\n]`)
    if (parsed.ok && parsed.stages.length && /^\s*\{/.test(inner))
      for (const s of parsed.stages) stages.push({ ...s, enabled: false })
  }
  return { ok: true, stages }
}

/** Assigns ids for the stage editor. */
export function withIds(stages: Omit<PipelineStage, 'id'>[]): PipelineStage[] {
  return stages.map((s) => ({ ...s, id: newStageId() }))
}

// ---------------------------------------------------------------- results (IPC)

/** Output of the pipeline up to one stage. */
export type StagePreview =
  | { status: 'ok'; docs: BsonBytes[]; ms: number }
  /** `own`: the error is in this stage's text (line/column are relative to its body). */
  | { status: 'error'; message: string; own: boolean; line?: number; column?: number }
  /** write: $out/$merge never run in previews; blocked: an earlier stage has an error. */
  | { status: 'skipped'; reason: 'write' | 'blocked' }

export type PipelineRunResult =
  | { kind: 'docs'; docs: BsonBytes[]; more: boolean; ms: number }
  | { kind: 'written'; target: string; ms: number }

export interface SavedPipeline {
  id: string
  name: string
  ns: string
  stages: Omit<PipelineStage, 'id'>[]
  options: PipelineOptions
  createdAt: number
}

/** True if a parsed stage (or anything nested in it) is $out or $merge. */
export function containsWriteStage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsWriteStage)
  if ((value as { _bsontype?: string })._bsontype) return false
  return Object.entries(value as Record<string, unknown>).some(
    ([k, v]) => isWriteStage(k) || containsWriteStage(v)
  )
}

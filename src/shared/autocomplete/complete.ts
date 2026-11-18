/**
 * Context-aware completions for shell-syntax editors (query bar, pipeline, update, documents).
 * Pure: takes text + offset + sampled field stats, returns editor-agnostic suggestions. The
 * Monaco adapter in the renderer maps them to CompletionItems.
 */
import { bsonTypeLabel } from '../bson-types'
import type { FieldStat } from '../field-stats'
import { shellKey } from '../shell-format'
import { analyze, type CursorContext, type Frame } from './context'
import {
  ACCUMULATORS,
  COLLATION_OPTIONS,
  CONSTRUCTORS,
  EXPRESSIONS,
  kindLabel,
  lookupOperator,
  PUSH_MODIFIERS,
  QUERY_OPERATORS,
  QUERY_TOP_OPERATORS,
  STAGES,
  SYSTEM_VARIABLES,
  toSnippet,
  UPDATE_OPERATORS,
  type OperatorInfo
} from './operators'
import { keySnippets, valueSnippets } from './snippets'

/** 'stage': the body of one pipeline stage (CompleteOptions.stage names its operator). */
export type CompletionMode =
  'filter' | 'project' | 'sort' | 'collation' | 'pipeline' | 'update' | 'document' | 'stage'

export type SuggestionKind =
  | 'field'
  | 'operator'
  | 'stage'
  | 'accumulator'
  | 'expression'
  | 'constructor'
  | 'value'
  | 'variable'
  | 'snippet'
  | 'option'

export interface Suggestion {
  label: string
  kind: SuggestionKind
  /** Monaco snippet syntax when `snippet` is true, plain text otherwise. */
  insertText: string
  snippet: boolean
  /** Short text shown next to the label (types and frequency, operator category…). */
  detail?: string
  /** Markdown docs. */
  doc?: string
  sortText: string
  filterText?: string
}

export interface CompletionResult {
  suggestions: Suggestion[]
  /** Text range to replace: [start, end) offsets. */
  replaceStart: number
  replaceEnd: number
  context: CursorContext
  scope: Scope
}

/** What kind of container the cursor is in, after walking the enclosing keys. */
export type Scope =
  | { type: 'query'; prefix: string; elemMatchOf?: string }
  | { type: 'fieldOps'; field: string }
  | { type: 'expr'; args?: string[] }
  | { type: 'group' }
  | { type: 'accum' }
  | { type: 'project' }
  | { type: 'newFields' }
  | { type: 'sort' }
  | { type: 'collation' }
  | { type: 'stage' }
  | { type: 'options'; stage: string; options: string[] }
  | { type: 'update' }
  | { type: 'updateFields'; op: string }
  | { type: 'pushMods' }
  | { type: 'document'; prefix: string }
  | { type: 'literal' }
  // arrays
  | { type: 'pipeline' }
  | { type: 'queryList'; prefix: string }
  | { type: 'values'; field: string }
  | { type: 'exprList' }
  | { type: 'documents' }
  | { type: 'literalArray' }

const LITERAL: Scope = { type: 'literal' }
const isOp = (k: string | null): k is string => !!k && k.startsWith('$')
const join = (prefix: string, key: string) => (prefix ? `${prefix}.${key}` : key)
const QUERY_FIELD_OPS = new Set(QUERY_OPERATORS.map((o) => o.name))
const UPDATE_FIELD_OPS = new Set(UPDATE_OPERATORS.map((o) => o.name).filter((n) => n !== '$bit'))
const EXPR_BY_NAME = new Map([...EXPRESSIONS, ...ACCUMULATORS].map((o) => [o.name, o]))

function rootScope(mode: CompletionMode, kind: Frame['kind'], stage?: string): Scope {
  const isArray = kind === 'array'
  switch (mode) {
    case 'stage':
      return stageChild(stage ?? null, kind)
    case 'filter':
      return { type: 'query', prefix: '' }
    case 'project':
      return { type: 'project' }
    case 'sort':
      return { type: 'sort' }
    case 'collation':
      return { type: 'collation' }
    case 'pipeline':
      return isArray ? { type: 'pipeline' } : { type: 'stage' }
    case 'update':
      return isArray ? { type: 'pipeline' } : { type: 'update' }
    case 'document':
      return isArray ? { type: 'documents' } : { type: 'document', prefix: '' }
  }
}

/** Scope of the container opened as the value of `key` inside an object in `scope`. */
function objectChild(scope: Scope, key: string | null, kind: Frame['kind']): Scope {
  const arr = kind === 'array'
  if (kind === 'call') return LITERAL
  switch (scope.type) {
    case 'query': {
      if (key === '$and' || key === '$or' || key === '$nor')
        return arr ? { type: 'queryList', prefix: scope.prefix } : LITERAL
      if (key === '$expr') return arr ? { type: 'exprList' } : { type: 'expr' }
      if (isOp(key)) {
        // Inside $elemMatch, field operators apply to the array's elements.
        if (scope.elemMatchOf !== undefined && QUERY_FIELD_OPS.has(key))
          return objectChild({ type: 'fieldOps', field: scope.elemMatchOf }, key, kind)
        return LITERAL
      }
      const field = join(scope.prefix, key ?? '')
      return arr ? { type: 'values', field } : { type: 'fieldOps', field }
    }
    case 'fieldOps':
      if (key === '$in' || key === '$nin' || key === '$all')
        return arr ? { type: 'values', field: scope.field } : LITERAL
      if (key === '$elemMatch')
        return arr ? LITERAL : { type: 'query', prefix: scope.field, elemMatchOf: scope.field }
      if (key === '$not') return arr ? LITERAL : { type: 'fieldOps', field: scope.field }
      if (key === '$eq' || key === '$ne') return arr ? { type: 'values', field: scope.field } : LITERAL
      return LITERAL
    case 'expr':
    case 'exprList':
      if (key === '$literal') return LITERAL
      if (isOp(key)) {
        const op = EXPR_BY_NAME.get(key)
        return arr ? { type: 'exprList' } : { type: 'expr', args: op?.args }
      }
      return arr ? { type: 'exprList' } : { type: 'expr' }
    case 'group':
      if (key === '_id') return arr ? { type: 'exprList' } : { type: 'newFields' }
      return arr ? LITERAL : { type: 'accum' }
    case 'accum': {
      const op = key ? EXPR_BY_NAME.get(key) : undefined
      return arr ? { type: 'exprList' } : { type: 'expr', args: op?.args }
    }
    case 'project':
    case 'newFields':
      return arr ? { type: 'exprList' } : { type: 'expr' }
    case 'stage':
      return stageChild(key, kind)
    case 'options':
      return optionChild(scope.stage, key, kind)
    case 'update':
      if (key && UPDATE_FIELD_OPS.has(key)) return arr ? LITERAL : { type: 'updateFields', op: key }
      return LITERAL
    case 'updateFields':
      if (scope.op === '$push' || scope.op === '$addToSet') return arr ? LITERAL : { type: 'pushMods' }
      if (scope.op === '$pull') return arr ? LITERAL : { type: 'query', prefix: '' }
      return LITERAL
    case 'document':
      return arr ? { type: 'literalArray' } : { type: 'document', prefix: join(scope.prefix, key ?? '') }
    default:
      return arr ? { type: 'literalArray' } : LITERAL
  }
}

function stageChild(stage: string | null, kind: Frame['kind']): Scope {
  const arr = kind === 'array'
  switch (stage) {
    case '$match':
      return arr ? LITERAL : { type: 'query', prefix: '' }
    case '$project':
      return arr ? LITERAL : { type: 'project' }
    case '$addFields':
    case '$set':
      return arr ? LITERAL : { type: 'newFields' }
    case '$group':
      return arr ? LITERAL : { type: 'group' }
    case '$sort':
      return arr ? LITERAL : { type: 'sort' }
    case '$facet':
      return arr ? LITERAL : { type: 'options', stage: '$facet', options: [] }
    case '$unionWith':
    case '$documents':
      if (arr) return stage === '$documents' ? { type: 'documents' } : LITERAL
      break
    case '$replaceWith':
    case '$sortByCount':
    case '$redact':
      return arr ? { type: 'exprList' } : { type: 'expr' }
    case '$unset':
    case '$count':
    case '$limit':
    case '$skip':
    case '$out':
      return arr ? { type: 'literalArray' } : LITERAL
  }
  const info = STAGES.find((s) => s.name === stage)
  if (arr) return LITERAL
  if (info?.args) return { type: 'options', stage: stage!, options: info.args }
  return { type: 'expr' }
}

function optionChild(stage: string, key: string | null, kind: Frame['kind']): Scope {
  const arr = kind === 'array'
  if (stage === '$facet') return arr ? { type: 'pipeline' } : LITERAL
  switch (key) {
    case 'pipeline':
      return arr ? { type: 'pipeline' } : LITERAL
    case 'let':
      return arr ? LITERAL : { type: 'newFields' }
    case 'newRoot':
    case 'groupBy':
    case 'startWith':
      return arr ? { type: 'exprList' } : { type: 'expr' }
    case 'output':
      return arr
        ? LITERAL
        : stage === '$bucket' || stage === '$bucketAuto'
          ? { type: 'group' }
          : { type: 'newFields' }
    case 'query':
    case 'restrictSearchWithMatch':
      return arr ? LITERAL : { type: 'query', prefix: '' }
    case 'sortBy':
      return arr ? LITERAL : { type: 'sort' }
  }
  return arr ? { type: 'literalArray' } : LITERAL
}

function arrayChild(scope: Scope, kind: Frame['kind']): Scope {
  const arr = kind === 'array'
  if (kind === 'call') return LITERAL
  switch (scope.type) {
    case 'pipeline':
      return arr ? LITERAL : { type: 'stage' }
    case 'queryList':
      return arr ? LITERAL : { type: 'query', prefix: scope.prefix }
    case 'exprList':
      return arr ? { type: 'exprList' } : { type: 'expr' }
    case 'documents':
      return arr ? { type: 'literalArray' } : { type: 'document', prefix: '' }
    case 'values':
      return arr ? { type: 'literalArray' } : LITERAL
    default:
      return arr ? { type: 'literalArray' } : LITERAL
  }
}

export function resolveScope(mode: CompletionMode, frames: Frame[], stage?: string): Scope {
  if (!frames.length) return LITERAL
  let scope = rootScope(mode, frames[0]!.kind, stage)
  for (let i = 0; i < frames.length - 1; i++) {
    const f = frames[i]!
    const next = frames[i + 1]!.kind
    scope =
      f.kind === 'object'
        ? objectChild(scope, f.key, next)
        : f.kind === 'array'
          ? arrayChild(scope, next)
          : LITERAL
  }
  return scope
}

// ---------------------------------------------------------------- suggestion builders

export interface CompleteOptions {
  mode: CompletionMode
  /** Sampled fields; `values` on a stat lists its distinct strings when there are few. */
  fields?: FieldStat[]
  now?: Date
  /** Mode 'stage': the stage operator whose body is being edited ("$match"…). */
  stage?: string
}

const order = {
  field: '1',
  snippet: '3',
  operator: '2',
  value: '0',
  constructor: '5',
  variable: '4'
} as const

function fieldDetail(stat: FieldStat): string {
  const types = stat.types
    .slice(0, 3)
    .map((t) => bsonTypeLabel[t.type])
    .join(' | ')
  return `${types}${stat.types.length > 3 ? ' …' : ''} · ${Math.round(stat.probability * 100)}%`
}

/** Fields under `prefix`, with the prefix stripped ("items.sku" → "sku" inside items). */
function fieldsUnder(fields: FieldStat[], prefix: string): { name: string; stat: FieldStat }[] {
  if (!prefix) return fields.map((stat) => ({ name: stat.path, stat }))
  const p = prefix + '.'
  return fields.filter((f) => f.path.startsWith(p)).map((stat) => ({ name: stat.path.slice(p.length), stat }))
}

function fieldKeys(ctx: CursorContext, fields: FieldStat[], prefix: string): Suggestion[] {
  return fieldsUnder(fields, prefix).map(({ name, stat }, i) => ({
    label: name,
    kind: 'field',
    insertText: ctx.quote ? name : shellKey(name),
    snippet: false,
    detail: fieldDetail(stat),
    filterText: name,
    // Keep sample order (top-level first) but put shallow paths before deep ones.
    sortText: `${order.field}${String(stat.depth).padStart(2, '0')}${String(i).padStart(4, '0')}`
  }))
}

function operatorKeys(
  ctx: CursorContext,
  ops: OperatorInfo[],
  kind: SuggestionKind,
  rank: string = order.operator
): Suggestion[] {
  return ops.map((o, i) => ({
    label: o.name,
    kind,
    insertText: ctx.quote || ctx.colonAfter ? toSnippet(o.name) : toSnippet(`${o.name}: ${o.value ?? '$1'}`),
    snippet: true,
    detail: kindLabel[o.kind],
    doc: o.doc,
    filterText: o.name,
    sortText: `${rank}${String(i).padStart(4, '0')}`
  }))
}

function plainKeys(ctx: CursorContext, names: string[], kind: SuggestionKind, detail?: string): Suggestion[] {
  return names.map((name, i) => ({
    label: name,
    kind,
    insertText: ctx.quote || ctx.colonAfter ? name : `${shellKey(name)}: `,
    snippet: false,
    detail,
    sortText: `${order.field}${String(i).padStart(4, '0')}`
  }))
}

function constructorValues(): Suggestion[] {
  return CONSTRUCTORS.map((c, i) => ({
    label: c.name,
    kind: 'constructor',
    insertText: c.snippet,
    snippet: true,
    detail: 'BSON type',
    doc: c.doc,
    sortText: `${order.constructor}${String(i).padStart(4, '0')}`
  }))
}

function sampledValues(ctx: CursorContext, field: string, fields: FieldStat[] | undefined): Suggestion[] {
  const list = fields?.find((f) => f.path === field)?.values ?? []
  return list.map((v, i) => ({
    label: JSON.stringify(v),
    kind: 'value',
    insertText: ctx.quote ? v : JSON.stringify(v),
    snippet: false,
    detail: `value of ${field}`,
    filterText: ctx.quote ? v : JSON.stringify(v),
    sortText: `${order.value}${String(i).padStart(4, '0')}`
  }))
}

function fieldPathValues(ctx: CursorContext, fields: FieldStat[]): Suggestion[] {
  const items: Suggestion[] = fields.map((stat, i) => ({
    label: `$${stat.path}`,
    kind: 'field',
    insertText: ctx.quote ? `$${stat.path}` : JSON.stringify(`$${stat.path}`),
    snippet: false,
    detail: fieldDetail(stat),
    filterText: ctx.quote ? `$${stat.path}` : `"$${stat.path}"`,
    sortText: `${order.field}${String(stat.depth).padStart(2, '0')}${String(i).padStart(4, '0')}`
  }))
  for (const [i, v] of SYSTEM_VARIABLES.entries())
    items.push({
      label: v.name,
      kind: 'variable',
      insertText: ctx.quote ? v.name : JSON.stringify(v.name),
      snippet: false,
      detail: 'system variable',
      doc: v.doc,
      filterText: ctx.quote ? v.name : `"${v.name}"`,
      sortText: `${order.variable}${String(i).padStart(4, '0')}`
    })
  return items
}

function stageElements(): Suggestion[] {
  return STAGES.map((s, i) => ({
    label: s.name,
    kind: 'stage',
    insertText: toSnippet(`{ ${s.name}: ${s.value ?? '{ $1 }'} }`),
    snippet: true,
    detail: kindLabel.stage,
    doc: s.doc,
    filterText: `{ ${s.name}`,
    sortText: `${order.operator}${String(i).padStart(4, '0')}`
  }))
}

const literal = (label: string, detail: string, rank: number): Suggestion => ({
  label,
  kind: 'value',
  insertText: label,
  snippet: false,
  detail,
  sortText: `${order.value}${rank}`
})

function keySuggestions(scope: Scope, ctx: CursorContext, o: CompleteOptions): Suggestion[] {
  const fields = o.fields ?? []
  switch (scope.type) {
    case 'query': {
      const out = [
        ...fieldKeys(ctx, fields, scope.prefix),
        ...operatorKeys(ctx, QUERY_TOP_OPERATORS, 'operator')
      ]
      if (scope.elemMatchOf !== undefined) out.push(...operatorKeys(ctx, QUERY_OPERATORS, 'operator', '25'))
      else if (!ctx.quote && !ctx.colonAfter) out.push(...keySnippets(o.now ?? new Date()))
      return out
    }
    case 'fieldOps':
      return operatorKeys(ctx, QUERY_OPERATORS, 'operator')
    case 'expr':
      if (scope.args) return plainKeys(ctx, scope.args, 'option', 'argument')
      return [
        ...operatorKeys(ctx, EXPRESSIONS, 'expression'),
        ...operatorKeys(
          ctx,
          ACCUMULATORS.filter((a) => a.alsoExpression && !EXPR_BY_NAME_EXPR.has(a.name)),
          'expression',
          '21'
        )
      ]
    case 'accum':
      return [
        ...operatorKeys(ctx, ACCUMULATORS, 'accumulator'),
        ...operatorKeys(ctx, EXPRESSIONS, 'expression', '22')
      ]
    case 'group':
      return plainKeys(ctx, ['_id'], 'field', 'group key')
    case 'project':
    case 'sort':
    case 'newFields':
    case 'updateFields':
      return fieldKeys(ctx, fields, '')
    case 'document':
      return fieldKeys(ctx, fields, scope.prefix)
    case 'collation':
      return operatorKeys(ctx, COLLATION_OPTIONS, 'option')
    case 'stage':
      return operatorKeys(ctx, STAGES, 'stage')
    case 'options':
      return plainKeys(ctx, scope.options, 'option', `${scope.stage} option`)
    case 'update':
      return operatorKeys(ctx, UPDATE_OPERATORS, 'operator')
    case 'pushMods':
      return operatorKeys(ctx, PUSH_MODIFIERS, 'operator')
    default:
      return []
  }
}
const EXPR_BY_NAME_EXPR = new Set(EXPRESSIONS.map((e) => e.name))

/** The field a value position belongs to, for sampled-value and snippet suggestions. */
function valueField(scope: Scope, key: string | null): string | null {
  if (scope.type === 'query' && key && !isOp(key)) return join(scope.prefix, key)
  if (scope.type === 'fieldOps' && (key === '$eq' || key === '$ne')) return scope.field
  if (scope.type === 'updateFields' && key) return key
  if (scope.type === 'document' && key) return join(scope.prefix, key)
  return null
}

function valueSuggestions(
  scope: Scope,
  ctx: CursorContext,
  key: string | null,
  o: CompleteOptions
): Suggestion[] {
  const fields = o.fields ?? []
  const exprValue =
    scope.type === 'expr' ||
    scope.type === 'accum' ||
    scope.type === 'newFields' ||
    scope.type === 'project' ||
    (scope.type === 'group' && key === '_id') ||
    (scope.type === 'options' && ['newRoot', 'groupBy', 'startWith', 'localField'].includes(key ?? '')) ||
    (scope.type === 'stage' && ['$unwind', '$replaceWith', '$sortByCount', '$group'].includes(key ?? ''))
  if (ctx.quote) {
    // Inside a string: field paths for expressions, sampled values for query fields.
    if (exprValue && ctx.prefix.startsWith('$')) return fieldPathValues(ctx, fields)
    const field = valueField(scope, key)
    return field ? sampledValues(ctx, field, o.fields) : []
  }
  if (scope.type === 'sort') return [literal('1', 'ascending', 0), literal('-1', 'descending', 1)]
  if (scope.type === 'project')
    return [literal('1', 'include', 0), literal('0', 'exclude', 1), ...fieldPathValues(ctx, fields)]
  if (exprValue) return [...fieldPathValues(ctx, fields), ...constructorValues()]
  if (scope.type === 'literal' || scope.type === 'stage' || scope.type === 'options')
    return constructorValues()
  const field = valueField(scope, key)
  const out = field ? sampledValues(ctx, field, o.fields) : []
  if (scope.type === 'query' && field) {
    const stat = fields.find((f) => f.path === field)
    out.push(...valueSnippets(o.now ?? new Date(), field, stat))
  }
  out.push(...constructorValues())
  return out
}

function elementSuggestions(scope: Scope, ctx: CursorContext, o: CompleteOptions): Suggestion[] {
  switch (scope.type) {
    case 'pipeline':
      return ctx.quote ? [] : stageElements()
    case 'values':
      return [...sampledValues(ctx, scope.field, o.fields), ...(ctx.quote ? [] : constructorValues())]
    case 'exprList':
      return ctx.quote && !ctx.prefix.startsWith('$')
        ? []
        : [...fieldPathValues(ctx, o.fields ?? []), ...(ctx.quote ? [] : constructorValues())]
    case 'literalArray':
      return ctx.quote ? [] : constructorValues()
    default:
      return []
  }
}

export function complete(text: string, offset: number, options: CompleteOptions): CompletionResult {
  const ctx = analyze(text, offset)
  const scope = resolveScope(options.mode, ctx.frames, options.stage)
  const inner = ctx.frames[ctx.frames.length - 1]
  let suggestions: Suggestion[] = []
  if (ctx.position === 'key') suggestions = keySuggestions(scope, ctx, options)
  else if (ctx.position === 'value') suggestions = valueSuggestions(scope, ctx, inner?.key ?? null, options)
  else if (ctx.position === 'element') suggestions = elementSuggestions(scope, ctx, options)
  else if (options.mode === 'stage' && ctx.position === 'root' && ctx.quote && ctx.prefix.startsWith('$'))
    // A bare field path as the whole stage body: { $unwind: "$items" }, { $sortByCount: "$x" }
    suggestions = fieldPathValues(ctx, options.fields ?? [])
  else if (ctx.position === 'root' && !text.trim() && options.mode !== 'stage') {
    suggestions =
      options.mode === 'pipeline'
        ? [{ label: '[ ]', kind: 'snippet', insertText: '[\n  $0\n]', snippet: true, sortText: '0' }]
        : [{ label: '{ }', kind: 'snippet', insertText: '{ $0 }', snippet: true, sortText: '0' }]
  }
  // Replace the whole prefix. Inside a string, also swallow the rest of the string's word.
  const after = text.slice(offset)
  const tail = ctx.quote ? (/^[^"'`\n]*/.exec(after)?.[0] ?? '') : (/^[\w$.]*/.exec(after)?.[0] ?? '')
  return { suggestions, replaceStart: ctx.prefixStart, replaceEnd: offset + tail.length, context: ctx, scope }
}

// ---------------------------------------------------------------- hover

export interface HoverInfo {
  start: number
  end: number
  markdown: string
}

/** Docs for the operator, BSON constructor or system variable under the cursor. */
export function hoverAt(text: string, offset: number): HoverInfo | null {
  const isWord = (ch: string | undefined) => !!ch && /[\w$]/.test(ch)
  let start = offset
  let end = offset
  while (start > 0 && isWord(text[start - 1])) start--
  while (end < text.length && isWord(text[end])) end++
  const word = text.slice(start, end)
  if (!word) return null
  if (word.startsWith('$$')) {
    const v = SYSTEM_VARIABLES.find((s) => s.name === word)
    return v ? { start, end, markdown: `**${v.name}** · system variable\n\n${v.doc}` } : null
  }
  if (word.startsWith('$')) {
    const ops = lookupOperator(word)
    if (!ops.length) return null
    const seen = new Set<string>()
    const parts = ops
      .filter((o) => !seen.has(kindLabel[o.kind] + o.doc) && seen.add(kindLabel[o.kind] + o.doc))
      .map((o) => `*${kindLabel[o.kind]}*: ${o.doc}`)
    return { start, end, markdown: `**${word}**\n\n${parts.join('\n\n')}` }
  }
  const ctor = CONSTRUCTORS.find((c) => c.name === word || c.name === `new ${word}`)
  if (ctor && text[end] === '(')
    return { start, end, markdown: `**${ctor.name}** · BSON type\n\n${ctor.doc}` }
  return null
}

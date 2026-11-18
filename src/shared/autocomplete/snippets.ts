/**
 * Ready-made query fragments offered in the filter editor. Rolling ranges ("last 7 days") use
 * `new Date(Date.now() - …)` so a saved query keeps meaning the last 7 days; calendar ranges
 * ("today") are computed for the local timezone when suggested.
 */
import type { BsonTypeTag } from '../bson-types'
import type { FieldStat } from '../field-stats'
import type { Suggestion } from './complete'

const DAY = 24 * 60 * 60 * 1000

function startOfLocalDay(d: Date, offsetDays = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays)
}

const iso = (d: Date) => `ISODate("${d.toISOString()}")`

/** ObjectId whose timestamp part is `d` (the rest zeros): `_id >= it` means created at/after d. */
export function objectIdAt(d: Date): string {
  const secs = Math.floor(d.getTime() / 1000)
  return `ObjectId("${secs.toString(16).padStart(8, '0')}0000000000000000")`
}

interface SnippetDef {
  label: string
  doc: string
  body: string
  /** Only offered for fields whose sampled types include one of these. */
  types?: BsonTypeTag[]
}

function dateSnippets(now: Date): SnippetDef[] {
  const today = startOfLocalDay(now)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  return [
    {
      label: 'Today',
      doc: 'Dates from local midnight today until midnight tonight.',
      body: `{ \\$gte: ${iso(today)}, \\$lt: ${iso(startOfLocalDay(now, 1))} }`
    },
    {
      label: 'Yesterday',
      doc: 'Dates during yesterday (local time).',
      body: `{ \\$gte: ${iso(startOfLocalDay(now, -1))}, \\$lt: ${iso(today)} }`
    },
    {
      label: 'Last 24 hours',
      doc: 'Rolling: always relative to when the query runs.',
      body: `{ \\$gte: new Date(Date.now() - ${DAY}) }`
    },
    {
      label: 'Last 7 days',
      doc: 'Rolling: always relative to when the query runs.',
      body: `{ \\$gte: new Date(Date.now() - ${7 * DAY}) }`
    },
    {
      label: 'Last 30 days',
      doc: 'Rolling: always relative to when the query runs.',
      body: `{ \\$gte: new Date(Date.now() - ${30 * DAY}) }`
    },
    {
      label: 'This month',
      doc: 'Dates from the first of this month (local time).',
      body: `{ \\$gte: ${iso(monthStart)}, \\$lt: ${iso(new Date(now.getFullYear(), now.getMonth() + 1, 1))} }`
    },
    {
      label: 'Between dates',
      doc: 'From the start date (inclusive) to the end date (exclusive).',
      body: `{ \\$gte: ISODate("\${1:${today.toISOString().slice(0, 10)}}"), \\$lt: ISODate("\${2:${startOfLocalDay(now, 1).toISOString().slice(0, 10)}}") }`
    }
  ].map((s) => ({ ...s, types: ['date' as const] }))
}

function idSnippets(now: Date): SnippetDef[] {
  return [
    {
      label: 'Created in the last 24 hours (from _id)',
      doc: 'ObjectIds start with their creation time, so a range on _id finds recent documents using the _id index.',
      body: `{ \\$gte: ${objectIdAt(new Date(now.getTime() - DAY))} }`,
      types: ['objectId']
    },
    {
      label: 'Created today (from _id)',
      doc: 'ObjectIds created since local midnight.',
      body: `{ \\$gte: ${objectIdAt(startOfLocalDay(now))} }`,
      types: ['objectId']
    },
    {
      label: 'Created before a date (from _id)',
      doc: 'ObjectIds created before the given date.',
      body: `{ \\$lt: ObjectId("\${1:${objectIdAt(startOfLocalDay(now)).slice(10, 34)}}") }`,
      types: ['objectId']
    }
  ]
}

const generic: SnippetDef[] = [
  {
    label: 'Contains text (case-insensitive)',
    doc: 'Strings containing the text anywhere, ignoring case. Can’t use an index efficiently.',
    body: '{ \\$regex: "${1:text}", \\$options: "i" }',
    types: ['string']
  },
  {
    label: 'Starts with',
    doc: 'Strings starting with the text (case-sensitive prefix regexes can use an index).',
    body: '{ \\$regex: "^${1:text}" }',
    types: ['string']
  },
  {
    label: 'Exact match, any case',
    doc: 'Whole-string match ignoring case.',
    body: '{ \\$regex: "^${1:text}\\$", \\$options: "i" }',
    types: ['string']
  },
  {
    label: 'Exists and not null',
    doc: 'Documents where the field is set to a non-null value.',
    body: '{ \\$exists: true, \\$ne: null }'
  },
  { label: 'Missing', doc: 'Documents without the field.', body: '{ \\$exists: false }' },
  { label: 'One of', doc: 'Any of the listed values.', body: '{ \\$in: [$1] }' },
  {
    label: 'Between numbers',
    doc: 'From min (inclusive) to max (exclusive).',
    body: '{ \\$gte: ${1:0}, \\$lt: ${2:100} }',
    types: ['int32', 'int64', 'double', 'decimal128']
  },
  {
    label: 'Non-empty array',
    doc: 'Arrays with at least one element.',
    body: '{ \\$exists: true, \\$ne: [] }',
    types: ['array']
  },
  {
    label: 'Has type',
    doc: 'Values of a given BSON type.',
    body: '{ \\$type: "${1|string,int,long,double,decimal,bool,date,objectId,array,object,null|}" }'
  }
]

const snippetSuggestion = (s: SnippetDef, i: number, rank: string): Suggestion => ({
  label: s.label,
  kind: 'snippet',
  insertText: s.body,
  snippet: true,
  detail: 'snippet',
  doc: `${s.doc}\n\n\`\`\`\n${s.body
    .replace(/\\\$/g, '$')
    .replace(/\$\{\d+(?::([^}]*)|\|([^|]*)[^}]*\|)\}/g, '$1$2')
    .replace(/\$\d/g, '…')}\n\`\`\``,
  sortText: `${rank}${String(i).padStart(4, '0')}`
})

/** Snippets for the value of `field` in a filter, most relevant to its sampled types first. */
export function valueSnippets(now: Date, field: string, stat: FieldStat | undefined): Suggestion[] {
  const types = new Set(stat?.types.map((t) => t.type) ?? [])
  const all = [
    ...(field === '_id' || types.has('objectId') ? idSnippets(now) : []),
    ...dateSnippets(now),
    ...generic
  ]
  // Typed snippets that match the field's types come first; typed ones that don't match last.
  const fits = (s: SnippetDef) => !s.types || !types.size || s.types.some((t) => types.has(t))
  return all.map((s, i) => snippetSuggestion(s, i, fits(s) ? (s.types && types.size ? '05' : '3') : '8'))
}

/** Snippets that write a whole condition at a key position of the filter. */
export function keySnippets(now: Date): Suggestion[] {
  return [
    {
      label: '_id created in the last 24 hours',
      doc: 'Recent documents by ObjectId creation time (uses the _id index).',
      body: `_id: { \\$gte: ${objectIdAt(new Date(now.getTime() - DAY))} }`
    },
    {
      label: 'Either condition ($or)',
      doc: 'Matches documents meeting either condition.',
      body: '\\$or: [{ ${1:field}: $2 }, { ${3:field}: $4 }]'
    }
  ].map((s, i) => snippetSuggestion(s, i, '3'))
}

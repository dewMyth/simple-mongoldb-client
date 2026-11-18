/**
 * Done when: exported Node and Python code runs and returns the same count.
 *
 * The generated programs are actually executed against a real mongod. Python needs pymongo:
 * set PYTHON, or create .venv-codegen (python3 -m venv .venv-codegen && .venv-codegen/bin/pip
 * install pymongo); without it the Python cases are skipped with a notice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MongoClient, type CollationOptions, type Document } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { bsonTypeOf, type BsonTypeTag } from '../../src/shared/bson-types'
import { exportQuery, type ExportLanguage, type ExportMode } from '../../src/shared/code-export'
import { toShellString } from '../../src/shared/shell-format'
import { emptyQueryText, type QueryText } from '../../src/shared/query'
import { parseQuery } from '../../src/main/services/query-parser'
import { allTypesDoc } from '../fixtures/all-types'

const root = resolve(import.meta.dirname, '../..')
// Inside node_modules so the generated ESM file resolves the "mongodb" package.
const workDir = join(root, 'node_modules/.cache/codegen-test')

function findPython(): string | null {
  const candidates = [process.env.PYTHON, join(root, '.venv-codegen/bin/python'), 'python3'].filter(
    (p): p is string => !!p && (p === 'python3' || existsSync(p))
  )
  for (const p of candidates)
    if (spawnSync(p, ['-c', 'import pymongo'], { encoding: 'utf8' }).status === 0) return p
  return null
}
const python = findPython()
if (!python)
  console.warn('[code-export] pymongo not found: Python export cases are skipped (see file header).')

let server: MongoMemoryServer
let client: MongoClient
let n = 0

function run(language: 'node' | 'python', code: string): string {
  mkdirSync(workDir, { recursive: true })
  const file = join(workDir, `q${n++}.${language === 'node' ? 'mjs' : 'py'}`)
  writeFileSync(file, code)
  const env: NodeJS.ProcessEnv = { ...process.env, MONGODB_URI: server.getUri() }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(language === 'node' ? process.execPath : python!, [file], {
    encoding: 'utf8',
    env,
    timeout: 30_000
  })
  if (r.status !== 0) throw new Error(`${language} export failed:\n${r.stderr}\n--- code ---\n${code}`)
  return r.stdout
}

function exported(
  language: ExportLanguage,
  text: Partial<QueryText>,
  mode: ExportMode,
  coll = 'orders'
): string {
  const parsed = parseQuery({ ...emptyQueryText, ...text })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors))
  return exportQuery(language, { db: 'shop', collection: coll }, parsed.query, mode)
}

async function expectedCount(text: Partial<QueryText>, coll = 'orders'): Promise<number> {
  const parsed = parseQuery({ ...emptyQueryText, ...text })
  if (!parsed.ok) throw new Error('parse')
  const { filter, skip, limit, collation, hint } = parsed.query
  return client
    .db('shop')
    .collection(coll)
    .countDocuments(filter, {
      skip,
      limit,
      collation: collation as CollationOptions | undefined,
      hint: hint as Document | string | undefined
    })
}

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  const orders = client.db('shop').collection('orders')
  await orders.insertMany(
    Array.from({ length: 120 }, (_, i) => ({
      i,
      status: ['new', 'paid', 'Paid', 'shipped'][i % 4],
      total: i % 3 === 0 ? i * 1.5 : i,
      createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 60))),
      customer: { name: `c${i % 7}`, tier: i % 2 ? 'gold' : 'silver' }
    }))
  )
  await orders.createIndex({ status: 1 })
  await client.db('shop').collection('types').insertOne(allTypesDoc())
})

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

const queries: { name: string; q: Partial<QueryText> }[] = [
  { name: 'empty filter', q: {} },
  {
    name: 'operators and dates',
    q: {
      filter: "{ status: { $in: ['paid', 'new'] }, createdAt: { $gte: ISODate('2026-01-15T00:00:00Z') } }"
    }
  },
  {
    name: 'nested $or and regex',
    q: { filter: "{ $or: [{ 'customer.tier': 'gold', total: { $gt: 50 } }, { status: /^ship/ }] }" }
  },
  {
    name: 'skip, limit, hint, maxTimeMS',
    q: { filter: "{ status: 'paid' }", skip: '3', limit: '10', hint: '{ status: 1 }', maxTimeMS: '5000' }
  },
  {
    name: 'collation (case-insensitive)',
    q: { filter: "{ status: 'paid' }", collation: "{ locale: 'en', strength: 2 }" }
  },
  { name: 'hint by index name', q: { filter: '{ total: { $lt: NumberLong(40) } }', hint: 'status_1' } }
]

describe('exported code returns the same count as the driver', () => {
  for (const { name, q } of queries) {
    it(`Node: ${name}`, async () => {
      const out = run('node', exported('node', q, 'count'))
      expect(Number(out.trim())).toBe(await expectedCount(q))
    })
    it.skipIf(!python)(`Python: ${name}`, async () => {
      const out = run('python', exported('python', q, 'count'))
      expect(Number(out.trim())).toBe(await expectedCount(q))
    })
  }
})

/** Filter that matches the all-types document only if every value AND its BSON type survive. */
function allTypesFilter(): string {
  const doc = allTypesDoc()
  const alias: Partial<Record<BsonTypeTag, string>> = {
    string: 'string',
    int32: 'int',
    int64: 'long',
    double: 'double',
    decimal128: 'decimal',
    boolean: 'bool',
    date: 'date',
    objectId: 'objectId',
    null: 'null',
    binary: 'binData',
    uuid: 'binData',
    timestamp: 'timestamp',
    regex: 'regex',
    minKey: 'minKey',
    maxKey: 'maxKey',
    code: 'javascript',
    object: 'object',
    array: 'array'
  }
  const filter: Document = {}
  for (const [k, v] of Object.entries(doc)) {
    // Dotted/$ keys can't be addressed in a filter; s/x regex flags have no shell syntax.
    if (k.includes('.') || k.startsWith('$') || k === 'regexFlags' || k === 'symbol' || k === 'dbRef')
      continue
    const scoped = bsonTypeOf(v) === 'code' && !!(v as { scope?: unknown }).scope
    const type = scoped ? 'javascriptWithScope' : alias[bsonTypeOf(v)]
    filter[k] = type && type !== 'array' ? { $eq: v, $type: type } : { $eq: v }
  }
  return toShellString(filter, 0)
}

describe('type preservation through exported code', () => {
  const q = () => ({ filter: allTypesFilter() })

  it('the type-checking filter matches the fixture via the driver', async () => {
    expect(await expectedCount(q(), 'types')).toBe(1)
  })

  it('Node code matches the all-types document', () => {
    expect(run('node', exported('node', q(), 'count', 'types')).trim()).toBe('1')
  })

  it.skipIf(!python)('Python code matches the all-types document', () => {
    expect(run('python', exported('python', q(), 'count', 'types')).trim()).toBe('1')
  })
})

describe('find mode runs', () => {
  const q = {
    filter: "{ status: 'paid' }",
    project: '{ status: 1, total: 1 }',
    sort: '{ total: -1 }',
    limit: '5'
  }

  it('Node prints the documents', () => {
    const out = run('node', exported('node', q, 'find'))
    expect(out.match(/status: 'paid'/g)).toHaveLength(5)
  })

  it.skipIf(!python)('Python prints one document per line', () => {
    const lines = run('python', exported('python', q, 'find'))
      .trim()
      .split('\n')
    expect(lines).toHaveLength(5)
    expect(lines.every((l) => l.includes("'status': 'paid'"))).toBe(true)
  })
})

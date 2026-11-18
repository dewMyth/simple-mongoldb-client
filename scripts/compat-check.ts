/**
 * Seeds a deterministic dataset and prints Mongo Studio's result counts for 20 sample queries,
 * as a Markdown table for docs/compat-check.md. Run the same queries in Compass against the same
 * data and fill in the Compass column.
 *
 *   npx tsx scripts/compat-check.ts                      # uses an in-memory server
 *   npx tsx scripts/compat-check.ts mongodb://localhost  # seeds compat_check.orders there
 */
import { Decimal128, Long, MongoClient, ObjectId } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { parseQuery } from '../src/main/services/query-parser'
import { emptyQueryText } from '../src/shared/query'

export const COMPAT_QUERIES: string[] = [
  '{}',
  '{ status: "paid" }',
  '{ status: { $in: ["paid", "shipped"] } }',
  '{ total: { $gte: NumberDecimal("100") } }',
  '{ qty: NumberLong(3) }',
  '{ qty: { $gt: 5, $lte: 8 } }',
  '{ createdAt: { $gte: ISODate("2026-03-01"), $lt: ISODate("2026-04-01") } }',
  '{ "customer.name": /^a/i }',
  '{ "customer.email": { $exists: false } }',
  '{ tags: "gift" }',
  '{ tags: { $all: ["gift", "express"] } }',
  '{ tags: { $size: 0 } }',
  '{ items: { $elemMatch: { sku: "B-2", qty: { $gte: 2 } } } }',
  '{ $or: [{ status: "cancelled" }, { total: { $lt: NumberDecimal("10") } }] }',
  '{ $expr: { $gt: ["$qty", "$minQty"] } }',
  '{ total: { $type: "decimal" } }',
  '{ flags: { $bitsAllSet: [0, 2] } }',
  '{ _id: { $gt: ObjectId("650000000000000000000100") } }',
  '{ "customer.name": { $regex: "smith", $options: "i" }, status: { $ne: "cancelled" } }',
  '{ loc: { $geoWithin: { $centerSphere: [[79.86, 6.92], 0.001] } } }'
]

const statuses = ['new', 'paid', 'shipped', 'cancelled']
const names = ['Alice Smith', 'adam', 'Bob', 'Carol Smith', 'dew', 'Eve']
const tagSets = [[], ['gift'], ['gift', 'express'], ['express'], ['bulk', 'gift', 'express']]

export function compatDocs() {
  return Array.from({ length: 500 }, (_, i) => ({
    _id: new ObjectId((0x650000000000000000000000n + BigInt(i)).toString(16).padStart(24, '0')),
    status: statuses[i % 4],
    total: Decimal128.fromString(((i * 7.31) % 250).toFixed(2)),
    qty: Long.fromNumber(i % 10),
    minQty: i % 7,
    createdAt: new Date(Date.UTC(2026, i % 6, 1 + (i % 28))),
    customer: i % 5 === 0 ? { name: names[i % 6] } : { name: names[i % 6], email: `u${i}@example.com` },
    tags: tagSets[i % 5],
    items: [
      { sku: `A-${i % 3}`, qty: i % 4 },
      { sku: `B-${i % 3}`, qty: (i + 1) % 4 }
    ],
    flags: i % 16,
    loc: { type: 'Point', coordinates: [79.86 + (i % 10) * 0.001, 6.92 + (i % 10) * 0.001] }
  }))
}

async function main() {
  const uri = process.argv[2]
  const mem = uri ? null : await MongoMemoryServer.create()
  const client = await MongoClient.connect(uri ?? mem!.getUri())
  try {
    const coll = client.db('compat_check').collection('orders')
    await coll.drop().catch(() => {})
    await coll.insertMany(compatDocs())
    await coll.createIndex({ loc: '2dsphere' })

    console.log('| # | Query | Mongo Studio | Compass |')
    console.log('|---|---|---|---|')
    for (const [i, text] of COMPAT_QUERIES.entries()) {
      const parsed = parseQuery({ ...emptyQueryText, filter: text })
      if (!parsed.ok) throw new Error(`${text}: ${parsed.errors[0]!.message}`)
      const n = await coll.countDocuments(parsed.query.filter)
      console.log(`| ${i + 1} | \`${text.replace(/\|/g, '\\|')}\` | ${n} | |`)
    }
  } finally {
    await client.close()
    await mem?.stop()
  }
}

void main()

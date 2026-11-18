/**
 * Benchmark dataset for Phase 5's performance budgets:
 *   bench.docs  – 1,000,000 documents of ~2 KB (mixed types, nested objects and arrays)
 *   bench.huge  – 3 documents of ~10 MB (a big array of subdocuments, a big string, big binary)
 *
 *   npx tsx scripts/seed-bench.ts mongodb://localhost:27017 [count]
 *
 * Deterministic (seeded PRNG), so runs are comparable. Drops and recreates both collections.
 */
import { BSON, Binary, Decimal128, Double, Int32, Long, MongoClient, ObjectId, type Document } from 'mongodb'

const uri = process.argv[2]
const COUNT = Number(process.argv[3] ?? 1_000_000)
const BATCH = 5_000
const PARALLEL = 4

/** mulberry32: tiny deterministic PRNG. */
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua colombo kandy galle tea spice cinnamon harbour'.split(
    ' '
  )
const STATUSES = ['new', 'paid', 'shipped', 'delivered', 'cancelled']
const CITIES = ['Colombo', 'Kandy', 'Galle', 'Jaffna', 'Negombo', 'Matara']

export function benchDoc(i: number): Document {
  const r = rng(i + 1)
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!
  const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
  const created = Date.UTC(2023, 0, 1) + Math.floor(r() * 3 * 365 * 86_400_000)
  return {
    // Timestamp + sequence: unique, deterministic, and the embedded time matches createdAt.
    _id: new ObjectId(
      Math.floor(created / 1000)
        .toString(16)
        .padStart(8, '0') + i.toString(16).padStart(16, '0')
    ),
    seq: new Int32(i),
    orderNo: Long.fromNumber(1_000_000_000 + i),
    status: pick(STATUSES),
    customer: {
      name: `${words(1)} ${words(1)}`,
      email: `user${i}@example.com`,
      tier: pick(['bronze', 'silver', 'gold']),
      address: {
        line1: `${Math.floor(r() * 900) + 1} ${words(2)} road`,
        city: pick(CITIES),
        zip: String(10000 + (i % 90000))
      }
    },
    total: Decimal128.fromString((r() * 5000).toFixed(2)),
    weightKg: new Double(Math.round(r() * 1000) / 10),
    paid: r() > 0.3,
    createdAt: new Date(created),
    tags: Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(WORDS)),
    items: Array.from({ length: 4 + Math.floor(r() * 4) }, (_, k) => ({
      sku: `SKU-${(i * 7 + k) % 10_000}`,
      qty: new Int32(1 + Math.floor(r() * 5)),
      price: Decimal128.fromString((r() * 500).toFixed(2)),
      note: words(6)
    })),
    notes: words(160)
  }
}

function hugeDocs(): Document[] {
  const r = rng(42)
  const tenMb = 10 * 1024 * 1024
  const array: Document[] = []
  while (BSON.calculateObjectSize({ array }) < tenMb) {
    for (let k = 0; k < 1000; k++)
      array.push({
        i: new Int32(array.length),
        label: `entry-${array.length}`,
        value: new Double(r() * 1000),
        at: new Date(1_700_000_000_000 + array.length)
      })
  }
  const bin = new Uint8Array(tenMb)
  for (let k = 0; k < bin.length; k++) bin[k] = Math.floor(r() * 256)
  return [
    { _id: 'big-array', description: 'One array of ~10 MB of subdocuments', array },
    { _id: 'big-string', description: 'One ~10 MB string', text: 'x'.repeat(tenMb) },
    { _id: 'big-binary', description: 'One ~10 MB binary', data: new Binary(bin, 0) }
  ]
}

async function main() {
  if (!uri) {
    console.error('Usage: npx tsx scripts/seed-bench.ts <connection string> [count]')
    process.exit(1)
  }
  const client = await MongoClient.connect(uri)
  const db = client.db('bench')
  const sample = benchDoc(0)
  console.log(`Average document size ≈ ${BSON.calculateObjectSize(sample)} bytes (doc 0)`)

  await db
    .collection('docs')
    .drop()
    .catch(() => {})
  const coll = db.collection('docs')
  const t0 = Date.now()
  let next = 0
  async function worker() {
    while (next < COUNT) {
      const start = next
      next += BATCH
      const end = Math.min(start + BATCH, COUNT)
      await coll.insertMany(
        Array.from({ length: end - start }, (_, k) => benchDoc(start + k)),
        { ordered: false }
      )
      if (end % 100_000 === 0)
        console.log(`  ${end.toLocaleString()} docs (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  await coll.createIndex({ seq: 1 })
  await coll.createIndex({ status: 1, createdAt: -1 })

  await db
    .collection('huge')
    .drop()
    .catch(() => {})
  const huge = hugeDocs()
  for (const d of huge)
    console.log(`  huge ${d._id}: ${(BSON.calculateObjectSize(d) / 1048576).toFixed(1)} MB`)
  await db.collection('huge').insertMany(huge)

  const stats = await db.command({ collStats: 'docs' })
  console.log(
    `Done in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${stats['count']} docs, avg ${stats['avgObjSize']} B, ${(stats['size'] / 1073741824).toFixed(2)} GB uncompressed`
  )
  await client.close()
}

if (process.argv[1]?.endsWith('seed-bench.ts')) void main()

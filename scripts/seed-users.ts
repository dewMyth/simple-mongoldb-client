/**
 * Creates the users the permission tests (and manual checks) rely on:
 *   reader  – read on shop
 *   writer  – readWrite on shop
 *   dba     – dbAdmin on logs
 * All passwords are "pw" and authSource is admin.
 *
 *   npx tsx scripts/seed-users.ts "mongodb://root:pw@localhost:27017/?authSource=admin"
 */
import { MongoClient } from 'mongodb'

export const TEST_USERS = {
  reader: [{ role: 'read', db: 'shop' }],
  writer: [{ role: 'readWrite', db: 'shop' }],
  dba: [{ role: 'dbAdmin', db: 'logs' }]
} as const

export const TEST_PASSWORD = 'pw'

export async function seedUsers(root: MongoClient): Promise<void> {
  const admin = root.db('admin')
  for (const [user, roles] of Object.entries(TEST_USERS)) {
    await admin.command({ dropUser: user }).catch(() => {})
    await admin.command({ createUser: user, pwd: TEST_PASSWORD, roles: [...roles] })
  }
  await root
    .db('shop')
    .collection('orders')
    .insertMany([{ n: 1 }, { n: 2 }])
  await root.db('logs').collection('events').insertOne({ level: 'info' })
}

if (process.argv[1]?.endsWith('seed-users.ts')) {
  const uri = process.argv[2]
  if (!uri) {
    console.error('Usage: npx tsx scripts/seed-users.ts <root connection string>')
    process.exit(1)
  }
  const client = await MongoClient.connect(uri)
  await seedUsers(client)
  await client.close()
  console.log(`Created ${Object.keys(TEST_USERS).join(', ')} (password "${TEST_PASSWORD}")`)
}

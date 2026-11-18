import { expect, test, type Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from './app'

let server: MongoMemoryServer
let authServer: MongoMemoryServer
const PASSWORD = 'E2e-Pa55word!'

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  authServer = await MongoMemoryServer.create({
    auth: { enable: true, customRootName: 'admin', customRootPwd: PASSWORD }
  })
  for (const [uri, label] of [
    [server.getUri(), 'a'],
    [
      `mongodb://admin:${encodeURIComponent(PASSWORD)}@127.0.0.1:${authServer.instanceInfo!.port}/?authSource=admin`,
      'b'
    ]
  ] as const) {
    const c = await MongoClient.connect(uri)
    await c
      .db(`shop_${label}`)
      .collection('orders')
      .insertMany([{ n: 1 }, { n: 2 }])
    await c.close()
  }
})

test.afterAll(async () => {
  await Promise.all([server?.stop(), authServer?.stop()])
})

async function addConnection(page: Page, name: string, uri: string, connect = true) {
  await page.getByTestId('new-connection').click()
  await page.getByTestId('conn-name').fill(name)
  await page.getByTestId('conn-uri').fill(uri)
  await page.getByTestId(connect ? 'save-connect' : 'save-connection').click()
}

test('connect, browse two connections side by side, and keep secrets off disk', async () => {
  const { app, page, userData } = await launchApp()
  try {
    const authUri = `mongodb://admin:${encodeURIComponent(PASSWORD)}@127.0.0.1:${authServer.instanceInfo!.port}/?authSource=admin`

    // Test connection shows server details before saving.
    await page.getByTestId('new-connection').click()
    await page.getByTestId('conn-uri').fill(authUri)
    await page.getByTestId('test-connection').click()
    await expect(page.getByTestId('test-result')).toContainText('Standalone')
    await expect(page.getByTestId('test-result')).toContainText('Latency')
    await page.getByTestId('conn-name').fill('Secured')
    await page.getByTestId('save-connect').click()

    await addConnection(page, 'Local', server.getUri())

    // Both trees are expanded at the same time.
    await page.getByTestId('db-shop_a').click()
    await page.getByTestId('db-shop_b').click()
    await expect(page.getByTestId('coll-shop_a.orders')).toContainText('2')
    await expect(page.getByTestId('coll-shop_b.orders')).toContainText('2')

    // Opening collections from each connection creates tabs.
    await page.getByTestId('coll-shop_a.orders').click()
    await page.getByTestId('coll-shop_b.orders').click({ modifiers: ['ControlOrMeta'] })
    await expect(page.getByRole('tab')).toHaveCount(2)

    // The password never lands on disk in plaintext (real safeStorage encryption).
    const files = readdirSync(userData).filter((f) => f.endsWith('.json'))
    expect(files).toContain('connections.json')
    for (const f of files) {
      const text = readFileSync(join(userData, f), 'utf8')
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain(encodeURIComponent(PASSWORD))
    }
  } finally {
    await app.close()
  }
})

test('an unreachable host shows a readable error within the timeout', async () => {
  const { app, page } = await launchApp()
  try {
    await page.getByTestId('new-connection').click()
    await page.getByTestId('conn-uri').fill('mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=1500')
    // Use the form's timeout field (the option in the URI would also work).
    await page.getByLabel('Server selection timeout (ms)').fill('1500')
    const t0 = Date.now()
    await page.getByTestId('test-connection').click()
    await expect(page.getByText(/Connection refused/)).toBeVisible({ timeout: 6000 })
    expect(Date.now() - t0).toBeLessThan(6000)
  } finally {
    await app.close()
  }
})

test('create and drop a collection from the sidebar', async () => {
  const { app, page } = await launchApp()
  try {
    await addConnection(page, 'Local', server.getUri())
    await page.getByTestId('db-shop_a').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Create collection…' }).click()
    await page.getByTestId('create-collection-name').fill('fresh')
    await page.getByTestId('create-collection-submit').click()
    await expect(page.getByTestId('coll-shop_a.fresh')).toBeVisible()

    await page.getByTestId('coll-shop_a.fresh').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Drop collection…' }).click()
    await expect(page.getByTestId('confirm-button')).toBeDisabled()
    await page.getByTestId('confirm-input').fill('fresh')
    await page.getByTestId('confirm-button').click()
    await expect(page.getByTestId('coll-shop_a.fresh')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

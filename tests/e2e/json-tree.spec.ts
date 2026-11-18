import { expect, test } from '@playwright/test'
import { Decimal128, Double, Int32, Long, MongoClient, ObjectId } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { launchApp } from './app'

let server: MongoMemoryServer

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  const c = await MongoClient.connect(server.getUri())
  await c
    .db('shop')
    .collection('orders')
    .insertOne({
      _id: new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9'),
      name: 'Dew',
      qty: Long.fromString('9007199254740993'),
      count: new Int32(7),
      ratio: new Double(10),
      total: Decimal128.fromString('10.50'),
      paid: true,
      note: null,
      createdAt: new Date('2026-01-15T10:30:00Z'),
      customer: { address: { city: 'Colombo', zip: '00100' }, tier: 'gold' },
      items: Array.from({ length: 120 }, (_, i) => ({ sku: `S-${i}` }))
    })
  await c.close()
})

test.afterAll(async () => {
  await server?.stop()
})

test('tree view: types, colours, expand/collapse, copy, text view', async () => {
  const { app, page } = await launchApp()
  try {
    await page.getByTestId('new-connection').click()
    await page.getByTestId('conn-uri').fill(server.getUri())
    await page.getByTestId('save-connect').click()
    await page.getByTestId('db-shop').click()
    await page.getByTestId('coll-shop.orders').click()
    const tree = page.getByTestId('json-tree').first()
    await expect(tree).toBeVisible()

    // Every value is typed correctly, including the ones JSON can't tell apart.
    const typeOf = (path: string) => tree.locator(`[data-path="${path}"]`).getAttribute('data-type')
    expect(await typeOf('_id')).toBe('objectId')
    expect(await typeOf('qty')).toBe('int64')
    expect(await typeOf('count')).toBe('int32')
    expect(await typeOf('ratio')).toBe('double')
    expect(await typeOf('total')).toBe('decimal128')
    expect(await typeOf('createdAt')).toBe('date')
    expect(await typeOf('note')).toBe('null')
    await expect(tree.locator('[data-path="qty"]')).toContainText('9007199254740993')
    await expect(tree.locator('[data-path="ratio"]')).toContainText('10.0')

    // Different types get different colours.
    const color = (path: string) =>
      tree
        .locator(`[data-path="${path}"] [data-testid="json-value"]`)
        .evaluate((el) => getComputedStyle(el).color)
    const colours = await Promise.all(
      ['name', 'count', 'qty', 'ratio', 'total', 'paid', 'createdAt', '_id', 'note'].map(color)
    )
    expect(new Set(colours).size).toBe(colours.length)

    // Nested objects start collapsed and expand on click.
    await expect(tree.locator('[data-path="customer"]')).toContainText('{ 2 fields }')
    await expect(tree.locator('[data-path="customer.tier"]')).toHaveCount(0)
    await tree.locator('[data-path="customer"]').click()
    await expect(tree.locator('[data-path="customer.tier"]')).toContainText('"gold"')
    await expect(tree.locator('[data-path="customer.address"]')).toContainText('{ 2 fields }')
    await tree.locator('[data-path="customer"]').click()
    await expect(tree.locator('[data-path="customer.tier"]')).toHaveCount(0)

    // Expand all opens every level; large arrays page in 50 at a time.
    await page.getByTestId('expand-all').click()
    await expect(tree.locator('[data-path="customer.address.city"]')).toContainText('"Colombo"')
    await expect(tree.locator('[data-path^="items."][data-path$=".sku"]')).toHaveCount(50)
    await tree.getByRole('button', { name: /Show 50 more/ }).click()
    await expect(tree.locator('[data-path^="items."][data-path$=".sku"]')).toHaveCount(100)
    await page.getByTestId('expand-all').click() // collapse all
    await expect(tree.locator('[data-path="customer.tier"]')).toHaveCount(0)

    // Copy a value.
    await tree.locator('[data-path="total"]').hover()
    await tree.locator('[data-path="total"]').getByTitle('Copy value').click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('10.50')

    // Text view shows shell syntax with explicit types.
    await page.getByTestId('view-text').click()
    await expect(page.getByTestId('doc').first()).toContainText('qty: NumberLong("9007199254740993")')
    await expect(page.getByTestId('doc').first()).toContainText('ratio: Double(10)')
    await page.getByTestId('view-tree').click()
    await expect(page.getByTestId('json-tree')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

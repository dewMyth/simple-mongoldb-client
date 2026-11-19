/**
 * README screenshots (docs/screenshots/*.png). Opt-in: `SCREENSHOTS=1 npx playwright test screenshots`
 * after `npm run build`.
 */
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { Decimal128, Int32, MongoClient, ObjectId } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { launchApp } from './app'

test.skip(!process.env['SCREENSHOTS'], 'set SCREENSHOTS=1 to regenerate the README screenshots')

const OUT = join(import.meta.dirname, '../../docs/screenshots')
let server: MongoMemoryServer
let admin: MongoClient

const customers = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Edsger Dijkstra']
const products = [
  ['Mechanical keyboard', '129.00'],
  ['USB-C hub', '39.90'],
  ['27" monitor', '289.00'],
  ['Desk lamp', '24.50']
] as const
const statuses = ['paid', 'shipped', 'pending', 'refunded']

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  const docs = Array.from({ length: 240 }, (_, i) => {
    const items = Array.from({ length: 1 + (i % 3) }, (_, k) => {
      const [name, price] = products[(i + k) % products.length]!
      return {
        sku: `SKU-${100 + ((i + k) % products.length)}`,
        name,
        qty: new Int32(1 + ((i * k) % 3)),
        price: Decimal128.fromString(price)
      }
    })
    const name = customers[i % customers.length]!
    return {
      _id: new ObjectId(),
      orderNo: new Int32(10_000 + i),
      customer: { name, email: `${name.split(' ')[0]!.toLowerCase()}@example.com`, vip: i % 7 === 0 },
      items,
      total: Decimal128.fromString(
        items.reduce((s, it) => s + Number(it.price.toString()) * it.qty.value, 0).toFixed(2)
      ),
      status: statuses[i % statuses.length],
      tags: i % 5 === 0 ? ['gift'] : [],
      createdAt: new Date(Date.UTC(2026, 9, 1 + (i % 28), 8 + (i % 10), (i * 7) % 60))
    }
  })
  await admin.db('shop').collection('orders').insertMany(docs)
})

test.afterAll(async () => {
  await admin?.close()
  await server?.stop()
})

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`) })

test('README screenshots', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    await page.evaluate(() =>
      (window as unknown as { api: { invoke: (c: string, a: unknown) => Promise<unknown> } }).api.invoke(
        'settings:setTheme',
        'dark'
      )
    )
    await page.getByTestId('new-connection').click()
    await page.getByTestId('conn-name').fill('Local shop')
    await page.getByTestId('conn-uri').fill(server.getUri())
    await page.getByTestId('save-connect').click()
    await page.getByTestId('db-shop').click()
    await page.getByTestId('coll-shop.orders').click()
    await expect(page.getByTestId('result-count')).toHaveText('240 documents')
    await page.waitForTimeout(500)
    await shot(page, 'documents')

    await page.getByTestId('view-table').click()
    await page.waitForTimeout(800)
    await shot(page, 'table')
    await page.getByTestId('view-tree').click()

    await page.getByTestId('open-schema').click()
    await expect(page.getByTestId('schema-summary')).toContainText('Analyzed')
    await page.waitForTimeout(800)
    await shot(page, 'schema')

    await page.getByTestId('db-shop').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open shell here' }).click()
    await expect
      .poll(async () => (await page.getByTestId('shell-terminal').innerText()).replace(/\u00a0/g, ' '), {
        timeout: 30_000
      })
      .toMatch(/shop> *$/m)
    await page.getByTestId('shell-terminal').click()
    await page.keyboard.type(
      'db.orders.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { n: -1 } }])'
    )
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('shell-last-output')).toContainText('refunded')
    await page.waitForTimeout(300)
    await shot(page, 'shell')
  } finally {
    await app.close()
  }
})

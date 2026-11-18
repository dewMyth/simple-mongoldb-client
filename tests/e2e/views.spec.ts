import { expect, test, type Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { bsonTypeLabel, bsonTypeOf } from '../../src/shared/bson-types'
import { allTypesDoc } from '../fixtures/all-types'
import { launchApp } from './app'

let server: MongoMemoryServer

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  const c = await MongoClient.connect(server.getUri())
  await c.db('shop').collection('alltypes').insertOne(allTypesDoc())
  await c
    .db('shop')
    .collection('people')
    .insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        name: `P${i}`,
        age: 20 + i,
        address: { city: 'Colombo', zip: String(i) },
        tags: ['a', 'b'],
        ...(i % 2 ? { nickname: `n${i}` } : {})
      }))
    )
  await c.close()
})

test.afterAll(async () => {
  await server?.stop()
})

async function open(page: Page, coll: string) {
  await page.getByTestId('new-connection').click()
  await page.getByTestId('conn-uri').fill(server.getUri())
  await page.getByTestId('save-connect').click()
  await page.getByTestId('db-shop').click()
  await page.getByTestId(`coll-shop.${coll}`).click()
}

test('every BSON type in the all-types document renders with the correct badge', async () => {
  const { app, page } = await launchApp()
  try {
    await open(page, 'alltypes')
    const tree = page.getByTestId('json-tree').first()
    await expect(tree).toBeVisible()
    const doc = allTypesDoc()
    for (const [field, value] of Object.entries(doc)) {
      const tag = bsonTypeOf(value)
      const row = tree.locator(`[data-path="${field}"]`)
      await expect(row, field).toHaveAttribute('data-type', tag)
      await expect(row.getByTestId('type-badge'), field).toHaveText(bsonTypeLabel[tag])
    }
    // Spot-check the cases most clients get wrong.
    await expect(tree.locator('[data-path="int64"]')).toContainText('9007199254740993')
    await expect(tree.locator('[data-path="doubleWhole"]')).toContainText('10.0')
    await expect(tree.locator('[data-path="decimal128"]')).toContainText('1234567890123456789012345678901234')
    await expect(tree.locator('[data-path="datePre1970"]')).toContainText('1969-07-20T20:17:40.000Z')
    await expect(tree.locator('[data-path="regexFlags"]')).toContainText('/a.b/imsx')
  } finally {
    await app.close()
  }
})

test('JSON view is syntax-coloured and copy actions work', async () => {
  const { app, page } = await launchApp()
  try {
    await open(page, 'alltypes')
    await page.getByTestId('view-json').click()
    const doc = page.getByTestId('doc').first()
    await expect(doc).toContainText('int64: NumberLong("9007199254740993")')
    await expect(doc.locator('span[class*="mtk"]').first()).toBeVisible() // Monaco token spans

    await doc.hover()
    await doc.getByTestId('copy-doc').click()
    await page.getByRole('menuitem', { name: 'Copy as relaxed JSON' }).click()
    // The clipboard is system-wide and written asynchronously: poll until the copy lands.
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText())).string
        } catch {
          return null
        }
      })
      .toBe('héllo wörld 🌍')

    // Copy field path from the tree.
    await page.getByTestId('view-tree').click()
    const row = page.getByTestId('json-tree').first().locator('[data-path="nested"]')
    await row.click()
    const deep = page.getByTestId('json-tree').first().locator('[data-path="nested.level2"]')
    await deep.hover()
    await deep.getByTitle('Copy field path').click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('nested.level2')
  } finally {
    await app.close()
  }
})

test('table view: sampled columns, typed cells, nested popover, paging', async () => {
  const { app, page } = await launchApp()
  try {
    await open(page, 'people')
    await page.getByTestId('view-table').click()
    const table = page.getByTestId('table-view')
    await expect(table).toBeVisible()
    for (const col of ['_id', 'name', 'age', 'address', 'tags', 'nickname'])
      await expect(table.getByTestId(`col-${col}`)).toBeVisible()
    await expect(table.getByTestId('col-age')).toContainText('Int32')
    await expect(table.getByTestId('col-nickname')).toContainText('50%')
    await expect(table.getByTestId('table-row')).toHaveCount(25)

    const first = table.getByTestId('table-row').first()
    await expect(first.locator('[data-field="age"] [data-type="int32"]')).toHaveText('20')
    await expect(first.locator('[data-field="nickname"]')).toHaveText('—') // missing field
    await first.locator('[data-field="address"] button').click()
    await expect(page.locator('[data-path="city"]').last()).toContainText('"Colombo"')
    await page.keyboard.press('Escape')

    await page.getByTestId('page-next').click()
    await expect(table.getByTestId('table-row')).toHaveCount(5)
    await expect(table.getByTestId('table-row').first().locator('td').first()).toHaveText('26')
  } finally {
    await app.close()
  }
})

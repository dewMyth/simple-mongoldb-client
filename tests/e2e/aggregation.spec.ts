import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { MongoClient, Decimal128 } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { stagesToText } from '../../src/shared/pipeline'
import { stageFixtures } from '../fixtures/pipelines'
import { launchApp } from './app'

let server: MongoMemoryServer
let admin: MongoClient

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  const shop = admin.db('shop')
  await shop
    .collection('products')
    .insertMany(['A', 'B', 'C', 'D'].map((sku) => ({ sku, name: `Product ${sku}` })))
  await shop.collection('orders').insertMany(
    Array.from({ length: 90 }, (_, i) => ({
      i,
      status: ['paid', 'shipped', 'new'][i % 3],
      total: Decimal128.fromString(`${5 + (i % 40)}.00`),
      items: [{ sku: ['A', 'B', 'C', 'D'][i % 4], qty: 1 + (i % 3), price: 2 }]
    }))
  )
})

test.afterAll(async () => {
  await admin?.close()
  await server?.stop()
})

async function openOrders(page: Page) {
  await page.getByTestId('new-connection').click()
  await page.getByTestId('conn-name').fill('Local')
  await page.getByTestId('conn-uri').fill(server.getUri())
  await page.getByTestId('save-connect').click()
  await page.getByTestId('db-shop').click()
  await page.getByTestId('coll-shop.orders').click()
  await expect(page.getByTestId('result-count')).toHaveText('90 documents')
}

/**
 * Replaces a Monaco editor's text by pasting (as users do with pipelines). Typing multi-line
 * text would trip Monaco's bracket auto-closing and auto-indent.
 */
let electronApp: ElectronApplication
async function replaceEditorText(page: Page, testId: string, text: string) {
  const lines = page.getByTestId(testId).locator('.view-lines')
  await lines.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await expect(lines).toHaveText('')
  await electronApp.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
  await page.keyboard.press('ControlOrMeta+V')
  // Monaco recycles line elements, so DOM order isn't line order: compare the characters.
  const chars = (t: string) => [...t.replace(/\u00a0/g, ' ').replace(/\s+/g, '')].sort().join('')
  await expect.poll(async () => chars(await lines.innerText())).toBe(chars(text))
}

const operators = (page: Page) =>
  page.getByTestId('stage-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-operator')))

test('Done when: a 6-stage pipeline previews correctly at each stage; text ↔ stages; reorder; disable', async () => {
  const { app, page } = await launchApp()
  electronApp = app
  try {
    await openOrders(page)
    // From the documents tab: the current filter becomes the first $match.
    await replaceEditorText(page, 'filter-editor', "{ status: 'paid' }")
    await page.getByTestId('open-aggregation').click()
    await expect(page.getByTestId('aggregation-tab')).toBeVisible()
    await expect(page.getByTestId('stage-card')).toHaveCount(1)
    await expect(page.getByTestId('stage-status').first()).toHaveText(/^20 documents/) // sample of 20

    // Text mode: paste the 6-stage fixture, then back to stages.
    await page.getByTestId('mode-text').click()
    await replaceEditorText(page, 'pipeline-text', stagesToText(stageFixtures[0]!.stages))
    await expect(page.getByTestId('stage-preview')).toContainText('revenue') // final output
    await page.getByTestId('mode-stages').click()
    await expect(page.getByTestId('stage-card')).toHaveCount(6)
    expect(await operators(page)).toEqual(['$match', '$unwind', '$group', '$lookup', '$project', '$sort'])

    // Every stage previews its own output.
    const status = page.getByTestId('stage-status')
    await expect(status.nth(0)).toHaveText(/^20 documents/)
    await expect(status.nth(1)).toHaveText(/^20 documents/)
    await expect(status.nth(2)).toHaveText(/^4 documents/) // 4 SKUs
    const cards = page.getByTestId('stage-card')
    await expect(cards.nth(1).getByTestId('stage-preview')).toContainText('items')
    await expect(cards.nth(2).getByTestId('stage-preview')).toContainText('revenue')
    await expect(cards.nth(3).getByTestId('stage-preview')).toContainText('product')
    await expect(cards.nth(4).getByTestId('stage-preview')).toContainText('Product ')
    await expect(status.nth(5)).toHaveText(/^4 documents/)

    // Text → stages → text keeps everything (including a disabled stage).
    await cards.nth(3).getByTestId('stage-enabled').click()
    await expect(cards.nth(3)).toContainText('Disabled')
    await page.getByTestId('mode-text').click()
    await expect(page.getByTestId('pipeline-text')).toContainText('// { $lookup: {')
    await page.getByTestId('mode-stages').click()
    expect(await operators(page)).toEqual(['$match', '$unwind', '$group', '$lookup', '$project', '$sort'])
    await expect(page.getByTestId('stage-card').nth(3)).toContainText('Disabled')

    // Reorder: menu and drag and drop.
    await page.getByTestId('stage-card').nth(4).getByTestId('stage-menu').click()
    await page.getByTestId('stage-move-down').click()
    await expect
      .poll(() => operators(page))
      .toEqual(['$match', '$unwind', '$group', '$lookup', '$sort', '$project'])
    await page
      .getByTestId('stage-card')
      .nth(5)
      .getByTestId('stage-drag')
      .dragTo(page.getByTestId('stage-card').nth(4).locator('.border-b').first(), {
        targetPosition: { x: 200, y: 2 }
      })
    await expect
      .poll(() => operators(page))
      .toEqual(['$match', '$unwind', '$group', '$lookup', '$project', '$sort'])
  } finally {
    await app.close()
  }
})

test('Done when: $out never runs during preview; it runs (with confirmation) on "Run with $out"', async () => {
  const { app, page } = await launchApp()
  electronApp = app
  try {
    await openOrders(page)
    await page.getByTestId('open-aggregation').click()
    await page.getByTestId('mode-text').click()
    await replaceEditorText(
      page,
      'pipeline-text',
      "[\n  { $match: { status: 'new' } },\n  { $out: 'orders_new' }\n]"
    )
    await page.getByTestId('mode-stages').click()
    const outCard = page.getByTestId('stage-card').nth(1)
    await expect(outCard.getByTestId('stage-note')).toContainText('never runs in previews')
    await expect(outCard).toContainText('Not previewed')
    await expect(page.getByTestId('stage-status').first()).toHaveText(/^20 documents/)
    await page.waitForTimeout(1500) // several preview rounds
    expect(await admin.db('shop').listCollections({ name: 'orders_new' }).toArray()).toHaveLength(0)

    await page.getByTestId('run-pipeline').click() // "Run with $out"
    await page.getByRole('button', { name: 'Run and write' }).click()
    await expect(page.getByTestId('run-summary')).toContainText('Wrote the results to shop.orders_new')
    expect(await admin.db('shop').collection('orders_new').countDocuments()).toBe(30)
  } finally {
    await app.close()
  }
})

test('run, save/load, export to code, create view', async () => {
  const { app, page } = await launchApp()
  electronApp = app
  try {
    await openOrders(page)
    await page.getByTestId('open-aggregation').click()
    await page.getByTestId('mode-text').click()
    await replaceEditorText(
      page,
      'pipeline-text',
      "[\n  { $group: { _id: '$status', n: { $sum: 1 } } },\n  { $sort: { _id: 1 } }\n]"
    )

    await page.getByTestId('run-pipeline').click()
    await expect(page.getByTestId('run-summary')).toHaveText(/^3 documents/)
    await expect(page.getByTestId('run-results')).toContainText('shipped')

    // Save, change, load back.
    await page.getByTestId('saved-pipelines').click()
    await page.getByTestId('save-pipeline').click()
    await page.getByTestId('save-pipeline-name').fill('By status')
    await page.getByTestId('save-pipeline-submit').click()
    await replaceEditorText(page, 'pipeline-text', '[]')
    await page.getByTestId('saved-pipelines').click()
    await page.getByTestId('load-pipeline-By status').click()
    await expect(page.getByTestId('pipeline-text')).toContainText("$group: { _id: '$status'")

    // Export to code.
    await page.getByTestId('export-pipeline').click()
    await page.getByTestId('export-lang-python').click()
    await expect(page.getByTestId('export-code')).toContainText('coll.aggregate(')
    await expect(page.getByTestId('export-code')).toContainText('"$group"')
    await page.keyboard.press('Escape')

    // Create a view and open it.
    await page.getByTestId('create-view').click()
    await page.getByTestId('view-name').fill('orders_by_status')
    await page.getByTestId('create-view-submit').click()
    await expect(page.getByTestId('tab-shop.orders_by_status')).toBeVisible()
    await expect(page.getByTestId('result-count')).toHaveText('3 documents')
    const info = await admin.db('shop').listCollections({ name: 'orders_by_status' }).toArray()
    expect(info[0]).toMatchObject({ type: 'view' })
  } finally {
    await app.close()
  }
})

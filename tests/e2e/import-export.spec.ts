import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Decimal128, Int32, Long } from 'bson'
import { allTypesDoc } from '../fixtures/all-types'
import { launchApp } from './app'

let server: MongoMemoryServer
let admin: MongoClient
const dir = mkdtempSync(join(tmpdir(), 'ms-e2e-io-'))
type NumDoc = { _id: unknown; [k: string]: unknown }

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  const shop = admin.db('shop')
  await shop.collection<NumDoc>('types').insertMany([
    allTypesDoc() as NumDoc,
    ...Array.from({ length: 49 }, (_, i) => ({
      _id: i,
      n: new Int32(i),
      big: Long.fromString(`${9007199254740993n + BigInt(i)}`),
      price: Decimal128.fromString(`${i}.99`),
      status: ['new', 'paid'][i % 2]
    }))
  ])
})

test.afterAll(async () => {
  await admin?.close()
  await server?.stop()
})

/** Native dialogs can't be driven: make them return these paths. */
async function stubDialogs(app: ElectronApplication, paths: { save?: string; open?: string }) {
  await app.evaluate(({ dialog }, p) => {
    if (p.save)
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: p.save
      })) as unknown as typeof dialog.showSaveDialog
    if (p.open)
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [p.open]
      })) as unknown as typeof dialog.showOpenDialog
  }, paths)
}

async function openTypes(page: Page) {
  await page.getByTestId('new-connection').click()
  await page.getByTestId('conn-name').fill('Local')
  await page.getByTestId('conn-uri').fill(server.getUri())
  await page.getByTestId('save-connect').click()
  await page.getByTestId('db-shop').click()
  await page.getByTestId('coll-shop.types').click()
  await expect(page.getByTestId('result-count')).toHaveText('50 documents')
}

async function rawDocs(coll: string): Promise<string[]> {
  const docs = await admin
    .db('shop')
    .collection(coll)
    .find({}, { raw: true, sort: { _id: 1 } })
    .toArray()
  return docs.map((d) => Buffer.from(d as unknown as Uint8Array).toString('hex'))
}

test('Done when: export then import via EJSON is lossless (through the UI)', async () => {
  const { app, page } = await launchApp()
  try {
    const file = join(dir, 'types.jsonl')
    await stubDialogs(app, { save: file, open: file })
    await openTypes(page)

    await page.getByTestId('more-actions').click()
    await page.getByTestId('menu-export').click()
    await page.getByTestId('export-source-collection').click()
    await page.getByTestId('export-format-jsonl').click()
    await page.getByTestId('export-start').click()
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId('job-summary')).toContainText('Exported 50 documents to types.jsonl')
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(50)
    await expect(page.getByTestId('status-jobs')).toContainText('Export types.jsonl · done')
    await page.keyboard.press('Escape')

    await page.getByTestId('more-actions').click()
    await page.getByTestId('menu-import').click()
    await page.getByTestId('import-choose').click()
    await expect(page.getByTestId('import-file')).toContainText('types.jsonl')
    await expect(page.getByTestId('import-preview').locator('[data-testid=json-tree]')).toHaveCount(20)
    await page.getByTestId('import-target').fill('types_copy')
    await page.getByTestId('import-start').click()
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId('job-summary')).toHaveText('Imported 50 documents.')
    expect(await rawDocs('types_copy')).toEqual(await rawDocs('types'))
  } finally {
    await app.close()
  }
})

test('CSV import with a type per column; skip errors reports bad rows', async () => {
  const { app, page } = await launchApp()
  try {
    const csv = join(dir, 'people.csv')
    writeFileSync(
      csv,
      'name,age,balance,joined\nAda,36,9007199254740993,2026-01-02\nBob,x,12,2025-12-01\nCy,41,7,2025-11-30\n'
    )
    await stubDialogs(app, { open: csv })
    await openTypes(page)
    await page.getByTestId('more-actions').click()
    await page.getByTestId('menu-import').click()
    await page.getByTestId('import-choose').click()
    await expect(page.getByTestId('import-preview')).toContainText('Ada')
    await expect(page.getByTestId('import-type-joined')).toHaveValue('date')
    await page.getByTestId('import-type-age').selectOption('int32')
    await page.getByTestId('import-type-balance').selectOption('int64')
    await page.getByTestId('import-target').fill('people')
    await page.getByTestId('import-start').click()
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId('job-summary')).toHaveText('Imported 2 documents; 1 failed.')
    await expect(page.getByTestId('job-errors')).toContainText('"x" isn’t an Int32')
    const ada = await admin.db('shop').collection('people').findOne({ name: 'Ada' }, { promoteValues: false })
    expect(ada!.age._bsontype).toBe('Int32')
    expect(ada!.balance._bsontype).toBe('Long')
    expect(String(ada!.balance)).toBe('9007199254740993')
    expect(ada!.joined).toBeInstanceOf(Date)
  } finally {
    await app.close()
  }
})

test('schema tab: mixed types, presence, and clicking a value filters', async () => {
  const { app, page } = await launchApp()
  try {
    await openTypes(page)
    await page.getByTestId('open-schema').click()
    await expect(page.getByTestId('schema-summary')).toContainText('Analyzed 50 documents')
    // `n` is Int32 in 49 documents; the all-types document doesn't have it.
    const n = page.getByTestId('schema-field-n')
    await expect(n.getByTestId('schema-presence')).toHaveText('in 98% of documents')
    await expect(n.getByTestId('schema-types')).toContainText('Int32 100%')
    // `_id` mixes ObjectId (1) and Int32 (49).
    const id = page.getByTestId('schema-field-_id')
    await expect(id.getByTestId('schema-types')).toContainText('Int32 98%')
    await expect(id.getByTestId('schema-types')).toContainText('ObjectId 2.0%')

    await page.getByTestId('schema-field-status').locator('[data-value=\'"paid"\']').click()
    await expect(page.getByTestId('schema-filter').locator('.view-lines')).toContainText('status: "paid"')
    await page.getByTestId('schema-analyze').click()
    await expect(page.getByTestId('schema-summary')).toContainText(
      'Analyzed 24 documents matching the filter'
    )
  } finally {
    await app.close()
  }
})

test('import is disabled in read-only mode', async () => {
  const { app, page } = await launchApp()
  try {
    await openTypes(page)
    await page.getByTestId('conn-Local').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Turn read-only on' }).click()
    await page.getByTestId('more-actions').click()
    await expect(page.getByTestId('menu-import')).toHaveAttribute('data-disabled', '')
    await expect(page.getByTestId('menu-import')).toContainText('Read-only')
  } finally {
    await app.close()
  }
})

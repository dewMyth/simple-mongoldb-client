/**
 * Fresh-install smoke test: connect with a saved password, query, edit, export and use the shell.
 * Runs with the rest of the suite, and against a packaged app in the release workflow:
 *   E2E_EXECUTABLE="release/mac-arm64/Mongo Studio.app/Contents/MacOS/Mongo Studio" npx playwright test smoke
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { Double, MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { seedUsers, TEST_PASSWORD } from '../../scripts/seed-users'
import { launchApp } from './app'

let server: MongoMemoryServer
let root: MongoClient
let port: number
let dir: string

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create({
    auth: { enable: true, customRootName: 'root', customRootPwd: 'rootpw' }
  })
  port = server.instanceInfo!.port
  root = await MongoClient.connect(`mongodb://root:rootpw@127.0.0.1:${port}/?authSource=admin`)
  await seedUsers(root)
  await root
    .db('shop')
    .collection('smoke')
    .insertMany(Array.from({ length: 40 }, (_, i) => ({ _id: i as never, i, price: new Double(i + 0.5) })))
  dir = mkdtempSync(join(tmpdir(), 'ms-smoke-'))
})

test.afterAll(async () => {
  await root?.close()
  await server?.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('smoke: connect, query, edit, export, shell', async () => {
  const { app, page } = await launchApp()
  try {
    // Connect with a password (saved encrypted with the OS keychain).
    await page.getByTestId('new-connection').click()
    await page.getByTestId('conn-name').fill('Smoke')
    await page
      .getByTestId('conn-uri')
      .fill(`mongodb://writer:${TEST_PASSWORD}@127.0.0.1:${port}/shop?authSource=admin`)
    await page.getByTestId('save-connect').click()
    await page.getByTestId('db-shop').click()
    await page.getByTestId('coll-shop.smoke').click()
    await expect(page.getByTestId('result-count')).toHaveText('40 documents')

    // Query.
    const lines = page.getByTestId('filter-editor').locator('.view-lines')
    await lines.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await expect(lines).toHaveText('')
    await page.keyboard.insertText('{ i: 7 }')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByTestId('result-count')).toHaveText('1 document')

    // Edit: the Double stays a Double.
    const tree = page.getByTestId('json-tree').first()
    await tree.hover()
    await tree.getByTestId('doc-edit').click()
    const editor = page.getByTestId('doc-editor')
    const input = editor.locator('[data-path="price"] [data-testid="value-input"]').first()
    await input.fill('99.25')
    await input.press('Enter')
    await editor.getByTestId('edit-save').click()
    await expect(page.getByTestId('doc-editor')).toHaveCount(0)
    const doc = await root
      .db('shop')
      .collection('smoke')
      .findOne({ _id: 7 as never }, { promoteValues: false })
    expect(doc!['price']).toBeInstanceOf(Double)
    expect((doc!['price'] as Double).value).toBe(99.25)

    // Export the collection (the save dialog is stubbed: main only accepts its own dialogs' paths).
    const file = join(dir, 'smoke.jsonl')
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as never
    }, file)
    await page.getByTestId('more-actions').click()
    await page.getByTestId('menu-export').click()
    await page.getByTestId('export-source-collection').click()
    await page.getByTestId('export-format-jsonl').click()
    await page.getByTestId('export-start').click()
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done')
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(40)
    await page.keyboard.press('Escape')

    // Shell (worker thread + native interrupt module, which packaging must keep working).
    await page.getByTestId('db-shop').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open shell here' }).click()
    await expect(page.getByTestId('shell-tab')).toBeVisible()
    const out = page.getByTestId('shell-last-output')
    await expect
      .poll(async () => (await page.getByTestId('shell-terminal').innerText()).replace(/\u00a0/g, ' '), {
        timeout: 30_000
      })
      .toMatch(/shop> *$/m)
    await page.getByTestId('shell-terminal').click()
    await page.keyboard.type('db.smoke.countDocuments({ i: { $gte: 10 } })')
    await page.keyboard.press('Enter')
    await expect(out).toHaveText('30', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

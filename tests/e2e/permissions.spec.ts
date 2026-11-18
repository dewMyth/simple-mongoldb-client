import { expect, test, type Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { seedUsers, TEST_PASSWORD } from '../../scripts/seed-users'
import { launchApp } from './app'

let server: MongoMemoryServer
let root: MongoClient
let port: number

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create({
    auth: { enable: true, customRootName: 'root', customRootPwd: 'rootpw' }
  })
  port = server.instanceInfo!.port
  root = await MongoClient.connect(`mongodb://root:rootpw@127.0.0.1:${port}/?authSource=admin`)
  await seedUsers(root)
})

test.afterAll(async () => {
  await root?.close()
  await server?.stop()
})

async function connectAs(page: Page, user: string, defaultDb = '') {
  await page.getByTestId('new-connection').click()
  await page.getByTestId('conn-name').fill(user)
  await page
    .getByTestId('conn-uri')
    .fill(`mongodb://${user}:${TEST_PASSWORD}@127.0.0.1:${port}/${defaultDb}?authSource=admin`)
  await page.getByTestId('save-connect').click()
}

/** Opens a context menu and returns { disabled, reason } for an item. */
async function menuItem(page: Page, target: string, label: string) {
  await page.getByTestId(target).click({ button: 'right' })
  const item = page.getByRole('menuitem', { name: new RegExp(`^${label}`) })
  await expect(item).toBeVisible()
  const disabled = (await item.getAttribute('data-disabled')) !== null
  const reason = (await item.getByTestId('menu-reason').count())
    ? await item.getByTestId('menu-reason').textContent()
    : null
  await page.keyboard.press('Escape')
  return { disabled, reason }
}

test('read user: writes disabled with reasons, access panel explains why', async () => {
  const { app, page } = await launchApp()
  try {
    await connectAs(page, 'reader', 'shop')
    expect(await menuItem(page, 'db-shop', 'Create collection')).toEqual({
      disabled: true,
      reason: 'reader lacks createCollection on shop.'
    })
    expect((await menuItem(page, 'db-shop', 'Drop database')).disabled).toBe(true)

    await page.getByTestId('db-shop').click()
    expect(await menuItem(page, 'coll-shop.orders', 'Drop collection')).toEqual({
      disabled: true,
      reason: 'reader lacks dropCollection on shop.orders.'
    })

    // Reading still works, and the panel lists exactly what's allowed.
    await page.getByTestId('coll-shop.orders').click()
    await expect(page.getByTestId('result-count')).toHaveText('2 documents')
    await expect(page.getByTestId('permissions-button')).toHaveText(/Limited access/)
    await page.getByTestId('permissions-button').click()
    const panel = page.getByTestId('permissions-panel')
    await expect(panel).toContainText('read on shop')
    await expect(panel.getByTestId('perm-find')).toHaveAttribute('data-allowed', 'true')
    await expect(panel.getByTestId('perm-insert')).toHaveAttribute('data-allowed', 'false')
    await expect(panel.getByTestId('perm-insert')).toContainText('reader lacks insert on shop.orders.')
  } finally {
    await app.close()
  }
})

test('readWrite and dbAdmin users get the right buttons per namespace', async () => {
  const { app, page } = await launchApp()
  try {
    await connectAs(page, 'writer', 'shop')
    await page.getByTestId('db-shop').click()
    expect((await menuItem(page, 'coll-shop.orders', 'Drop collection')).disabled).toBe(false)
    expect((await menuItem(page, 'db-shop', 'Create collection')).disabled).toBe(false)
    expect(await menuItem(page, 'db-shop', 'Drop database')).toEqual({
      disabled: true,
      reason: 'writer lacks dropDatabase on shop.'
    })

    await connectAs(page, 'dba', 'logs')
    expect((await menuItem(page, 'db-logs', 'Drop database')).disabled).toBe(false)
    expect((await menuItem(page, 'db-logs', 'Create collection')).disabled).toBe(false)
  } finally {
    await app.close()
  }
})

test('read-only mode blocks writes in the UI and in main, and toggles from the tab lock', async () => {
  const { app, page } = await launchApp()
  try {
    await connectAs(page, 'writer', 'shop')
    await page.getByTestId('db-shop').click()
    await page.getByTestId('coll-shop.orders').click()
    await expect(page.getByTestId('tab-lock')).toHaveCount(0)

    await page.getByTestId('permissions-button').click()
    await page.getByTestId('readonly-switch').click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('tab-lock')).toBeVisible()
    await expect(page.getByTestId('permissions-button')).toHaveText(/Read-only/)
    expect(await menuItem(page, 'coll-shop.orders', 'Drop collection')).toEqual({
      disabled: true,
      reason: 'Read-only mode is on for this connection.'
    })

    // A write sent straight over IPC (bypassing the disabled UI) is refused by main.
    const res = await page.evaluate(async () => {
      const list = await window.api.invoke('connections:list')
      if (!list.ok) throw new Error(list.error.message)
      return window.api.invoke('db:dropCollection', {
        connectionId: list.data[0]!.id,
        db: 'shop',
        name: 'orders'
      })
    })
    expect(res).toMatchObject({ ok: false, error: { message: 'Read-only mode is on for this connection.' } })
    expect(await root.db('shop').collection('orders').countDocuments()).toBe(2)

    // The setting persists on the saved connection.
    await expect(page.getByTestId('conn-writer').getByLabel('Read-only')).toBeVisible()

    // Clicking the tab lock turns it off again.
    await page.getByTestId('tab-lock').click()
    await expect(page.getByTestId('tab-lock')).toHaveCount(0)
    expect((await menuItem(page, 'coll-shop.orders', 'Drop collection')).disabled).toBe(false)
  } finally {
    await app.close()
  }
})

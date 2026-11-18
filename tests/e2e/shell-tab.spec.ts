import { expect, test, type Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { launchApp } from './app'

let server: MongoMemoryServer
let admin: MongoClient

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  await admin
    .db('shop')
    .collection('orders')
    .insertMany(Array.from({ length: 300 }, (_, i) => ({ i, status: i % 2 ? 'paid' : 'new' })))
})

test.afterAll(async () => {
  await admin?.close()
  await server?.stop()
})

/** The shell's operations and cursors on the server (its appName starts with mongo-studio-shell). */
async function shellOps() {
  return admin
    .db('admin')
    .aggregate([
      { $currentOp: { allUsers: true, idleCursors: true } },
      { $match: { $or: [{ appName: /^mongo-studio-shell/ }, { type: 'idleCursor', ns: 'shop.orders' }] } }
    ])
    .toArray()
}

const screen = (page: Page) =>
  page
    .getByTestId('shell-terminal')
    .locator('.xterm-rows')
    .innerText()
    .then((t) => t.replace(/\u00a0/g, ' '))

async function openShell(page: Page) {
  await page.getByTestId('new-connection').click()
  await page.getByTestId('conn-name').fill('Local')
  await page.getByTestId('conn-uri').fill(server.getUri())
  await page.getByTestId('save-connect').click()
  await page.getByTestId('db-shop').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open shell here' }).click()
  await expect(page.getByTestId('shell-tab')).toBeVisible()
  await expect.poll(() => screen(page), { timeout: 20_000 }).toMatch(/shop> *$/m)
}

const lastOutput = (page: Page) => page.getByTestId('shell-last-output')

/** Types a command and waits for it to finish; returns its output (plain text). */
async function run(page: Page, code: string, wait = true): Promise<string> {
  const before = Number(await lastOutput(page).getAttribute('data-runs'))
  await page.getByTestId('shell-terminal').click()
  await page.keyboard.type(code)
  await page.keyboard.press('Enter')
  if (!wait) return ''
  await expect(lastOutput(page)).toHaveAttribute('data-runs', String(before + 1), { timeout: 15_000 })
  return (await lastOutput(page).textContent()) ?? ''
}

test('Done when: find().limit(3), aggregate([...]) and `it` work as in mongosh', async () => {
  const { app, page } = await launchApp()
  try {
    await openShell(page)
    let out = await run(page, 'db.orders.find().limit(3)')
    expect(out.match(/_id: ObjectId\("/g)).toHaveLength(3)
    expect(out).toContain('i: 2')
    expect(out).not.toContain('Type "it" for more')

    out = await run(page, 'db.orders.find({}, { _id: 0, i: 1 })')
    expect(out).toContain('Type "it" for more')
    expect(out).not.toContain('i: 20')
    out = await run(page, 'it')
    expect(out).toMatch(/^\[\s*\{\s*i: 20\s*\}/) // the second batch starts at 20
    expect(out).toContain('i: 39')

    out = await run(
      page,
      "db.orders.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])"
    )
    expect(out).toContain('_id: "new"')
    expect(out).toContain('n: 150')

    // Real mongosh helpers: use, show collections, multi-line input, errors.
    expect(await run(page, 'show collections')).toContain('orders')
    // Multi-line input: Enter inside open brackets continues the command.
    await run(page, 'db.orders.countDocuments({', false)
    await page.keyboard.type("status: 'paid' })")
    await page.keyboard.press('Enter')
    await expect(lastOutput(page)).toHaveText('150')
    expect(await run(page, 'db.orders.find({ $bad: 1 }).toArray()')).toMatch(
      /unknown top level operator: \$bad/i
    )
    expect(await run(page, 'use other')).toBe('switched to db other')
  } finally {
    await app.close()
  }
})

test('Done when: Ctrl+C interrupts a long find and frees the cursor', async () => {
  const { app, page } = await launchApp()
  try {
    await openShell(page)
    await run(page, 'db.orders.find({ $where: "sleep(100) || true" }).toArray()', false)
    await expect
      .poll(async () => (await shellOps()).filter((o) => o.type === 'op').length, { timeout: 10_000 })
      .toBeGreaterThan(0)
    await page.keyboard.press('Control+c')
    await expect(lastOutput(page)).toHaveText(/interrupted/i)
    await expect.poll(async () => (await shellOps()).length, { timeout: 10_000 }).toBe(0)
    // The shell keeps working afterwards.
    expect(await run(page, 'db.orders.countDocuments()')).toBe('300')
  } finally {
    await app.close()
  }
})

test('Done when: in read-only mode, insertOne is refused with a message; closing the tab frees cursors', async () => {
  const { app, page } = await launchApp()
  try {
    await openShell(page)
    await page.getByTestId('conn-Local').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Turn read-only on' }).click()
    await expect(page.getByTestId('tab-lock')).toBeVisible()

    const out = await run(page, 'db.orders.insertOne({ x: 1 })')
    expect(out).toContain('Read-only mode')
    expect(out).toContain('db.collection.insertOne() is blocked')
    expect(await admin.db('shop').collection('orders').countDocuments({ x: 1 })).toBe(0)
    await expect(page.getByTestId('shell-readonly')).toBeVisible()

    expect(await run(page, "db.orders.aggregate([{ $match: {} }, { $out: 'copy' }])")).toContain(
      '$out or $merge'
    )
    expect(await run(page, 'db.runCommand({ drop: "orders" })')).toContain('db.runCommand({ drop')
    // Reads still work.
    expect(await run(page, 'db.orders.countDocuments()')).toBe('300')

    // Turning read-only off applies to the open shell.
    await page.getByTestId('conn-Local').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Turn read-only off' }).click()
    expect(await run(page, 'db.orders.insertOne({ x: 1 }).acknowledged')).toBe('true')
    await expect(page.getByTestId('shell-readonly')).toHaveCount(0)
    await expect.poll(() => admin.db('shop').collection('orders').countDocuments({ x: 1 })).toBe(1)

    // Leave a cursor open (for `it`), then close the tab: the cursor is freed.
    await run(page, 'db.orders.find()')
    await expect.poll(async () => (await shellOps()).filter((o) => o.type === 'idleCursor').length).toBe(1)
    await page.getByRole('tab').filter({ hasText: 'shell' }).getByLabel('Close tab').click()
    await expect.poll(async () => (await shellOps()).length, { timeout: 10_000 }).toBe(0)
  } finally {
    await app.close()
  }
})

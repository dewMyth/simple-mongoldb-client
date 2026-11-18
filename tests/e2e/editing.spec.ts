import { expect, test, type Locator, type Page } from '@playwright/test'
import { BSON, Decimal128, Long, MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { allTypesDoc, ALL_TYPES_ID } from '../fixtures/all-types'
import { launchApp } from './app'

let server: MongoMemoryServer
let admin: MongoClient
const shop = () => admin.db('shop')
const decode = (d: object) => BSON.deserialize(BSON.serialize(d), { promoteValues: false, bsonRegExp: true })

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
})

test.afterAll(async () => {
  await admin?.close()
  await server?.stop()
})

async function open(page: Page, coll: string) {
  await page.getByTestId('new-connection').click()
  await page.getByTestId('conn-uri').fill(server.getUri())
  await page.getByTestId('save-connect').click()
  await page.getByTestId('db-shop').click()
  await page.getByTestId(`coll-shop.${coll}`).click()
  await expect(page.getByTestId('json-tree').first()).toBeVisible()
}

async function startEdit(page: Page, mode: 'doc-edit' | 'doc-edit-json' = 'doc-edit'): Promise<Locator> {
  const tree = page.getByTestId('json-tree').first()
  await tree.hover()
  await tree.getByTestId(mode).click()
  return page.getByTestId('doc-editor')
}

/** Replace a Monaco editor's text, waiting for each step to land (keystrokes can outrun Monaco). */
async function replaceText(page: Page, editor: Locator, text: string) {
  const lines = editor.locator('.view-lines')
  await lines.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await expect(lines).toHaveText('')
  await page.keyboard.insertText(text)
  await expect(lines).toHaveText(text)
}

async function setValue(editor: Locator, path: string, value: string) {
  const input = editor.locator(`[data-path="${path}"] [data-testid="value-input"]`).first()
  await input.fill(value)
  await input.press('Enter')
}

test('editing one field keeps every other field byte-identical, and Decimal128 stays Decimal128', async () => {
  await shop().collection('alltypes').insertOne(allTypesDoc())
  const { app, page } = await launchApp()
  try {
    await open(page, 'alltypes')
    let editor = await startEdit(page)
    await setValue(editor, 'string', 'changed')
    await expect(editor.getByTestId('change-count')).toHaveText('1 change')
    await editor.getByTestId('edit-save').click()
    await expect(page.getByTestId('doc-editor')).toHaveCount(0)
    await expect(page.getByTestId('json-tree').first().locator('[data-path="string"]')).toContainText(
      '"changed"'
    )

    const after = decode(
      (await shop()
        .collection('alltypes')
        .findOne({ _id: ALL_TYPES_ID }, { promoteValues: false, bsonRegExp: true }))!
    )
    const before = decode(allTypesDoc())
    expect(after['string']).toBe('changed')
    delete after['string']
    delete before['string']
    expect(Buffer.from(BSON.serialize(after)).equals(Buffer.from(BSON.serialize(before)))).toBe(true)

    // Decimal128 edit.
    editor = await startEdit(page)
    await setValue(editor, 'decimal128Small', '12.75')
    await editor.getByTestId('edit-save').click()
    await expect(page.getByTestId('doc-editor')).toHaveCount(0)
    const dec = (await shop()
      .collection('alltypes')
      .findOne({ _id: ALL_TYPES_ID }, { promoteValues: false }))!['decimal128Small']
    expect(dec._bsontype).toBe('Decimal128')
    expect(dec.toString()).toBe('12.75')
  } finally {
    await app.close()
  }
})

test('a concurrent change shows the conflict dialog: reload or overwrite', async () => {
  await shop()
    .collection('conflict')
    .insertOne({ _id: 1 as never, name: 'original', n: 1 })
  const { app, page } = await launchApp()
  try {
    await open(page, 'conflict')
    let editor = await startEdit(page)
    await setValue(editor, 'name', 'mine')
    await shop()
      .collection('conflict')
      .updateOne({ _id: 1 as never }, { $set: { name: 'theirs' } })
    await editor.getByTestId('edit-save').click()
    const dialog = page.getByTestId('conflict-dialog')
    await expect(dialog).toContainText('Document changed on server')
    await expect(dialog).toContainText('theirs')
    await dialog.getByTestId('conflict-reload').click()
    await expect(page.getByTestId('json-tree').first().locator('[data-path="name"]')).toContainText(
      '"theirs"'
    )

    // Again, but keep mine this time.
    editor = await startEdit(page)
    await setValue(editor, 'name', 'mine')
    await shop()
      .collection('conflict')
      .updateOne({ _id: 1 as never }, { $set: { name: 'theirs again' } })
    await editor.getByTestId('edit-save').click()
    await page.getByTestId('conflict-overwrite').click()
    await expect(page.getByTestId('doc-editor')).toHaveCount(0)
    expect(
      (await shop()
        .collection('conflict')
        .findOne({ _id: 1 as never }))!['name']
    ).toBe('mine')
  } finally {
    await app.close()
  }
})

test('type changes, validation, add/rename/delete fields and undo', async () => {
  await shop()
    .collection('types')
    .insertOne({ _id: 1 as never, n: 5, keep: 'x', drop: true })
  const { app, page } = await launchApp()
  try {
    await open(page, 'types')
    const editor = await startEdit(page)

    // Int32 → Int64 via the dropdown.
    await editor.locator('[data-path="n"] [data-testid="type-select"]').selectOption('int64')
    // An impossible conversion explains itself and changes nothing.
    await setValue(editor, 'keep', 'hello')
    await editor.locator('[data-path="keep"] [data-testid="type-select"]').selectOption('int32')
    await expect(editor.getByTestId('type-error')).toContainText('Can\'t convert "hello" to Int32')
    // Invalid input for the type is flagged, not saved.
    await editor.locator('[data-path="n"] [data-testid="value-input"]').fill('1.5')
    await expect(editor.getByTestId('value-error')).toContainText('whole number')
    await editor.locator('[data-path="n"] [data-testid="value-input"]').press('Escape')

    // Rename, delete, add.
    await editor.locator('[data-path="keep"] [data-testid="key-input"]').fill('kept')
    await editor.locator('[data-path="keep"] [data-testid="key-input"]').press('Enter')
    await editor.locator('[data-path="drop"]').hover()
    await editor.locator('[data-path="drop"] [data-testid="delete-field"]').click()
    await editor.getByTestId('add-field').last().click()
    await setValue(editor, 'field', 'added')

    // Undo the add, then save.
    await editor.getByRole('button', { name: 'Undo' }).click()
    await editor.getByRole('button', { name: 'Undo' }).click()
    await expect(editor.locator('[data-path="field"]')).toHaveCount(0)
    await editor.getByTestId('edit-save').click()
    await expect(page.getByTestId('doc-editor')).toHaveCount(0)

    const saved = (await shop()
      .collection('types')
      .findOne({ _id: 1 as never }, { promoteValues: false }))!
    expect(Object.keys(saved)).toEqual(['_id', 'n', 'kept'])
    expect(saved['n']._bsontype).toBe('Long')
    expect(saved['kept']).toBe('hello')
  } finally {
    await app.close()
  }
})

test('edit as JSON keeps shell-syntax types', async () => {
  await shop()
    .collection('jsonedit')
    .insertOne({
      _id: 1 as never,
      big: Long.fromString('9007199254740993'),
      price: Decimal128.fromString('1.10')
    })
  const { app, page } = await launchApp()
  try {
    await open(page, 'jsonedit')
    const editor = await startEdit(page, 'doc-edit-json')
    await replaceText(
      page,
      editor.getByTestId('json-doc-editor'),
      '{ _id: 1, big: NumberLong("9007199254740995"), price: NumberDecimal("2.20"), when: ISODate("2026-01-01") }'
    )
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByTestId('doc-editor')).toHaveCount(0)
    const saved = (await shop()
      .collection('jsonedit')
      .findOne({ _id: 1 as never }, { promoteValues: false }))!
    expect(saved['big'].toString()).toBe('9007199254740995')
    expect(saved['big']._bsontype).toBe('Long')
    expect(saved['price']._bsontype).toBe('Decimal128')
    expect(saved['when']).toEqual(new Date('2026-01-01T00:00:00Z'))
  } finally {
    await app.close()
  }
})

test('insert, clone, delete, bulk update with preview, bulk delete', async () => {
  await shop()
    .collection('bulk')
    .insertMany(Array.from({ length: 6 }, (_, i) => ({ _id: i, n: i, tag: 'x' })) as never)
  const { app, page } = await launchApp()
  try {
    await open(page, 'bulk')
    await expect(page.getByTestId('result-count')).toHaveText('6 documents')

    // Insert two documents.
    await page.getByTestId('insert-button').click()
    await replaceText(
      page,
      page.getByTestId('insert-editor'),
      '[{ _id: 100, n: NumberLong(100) }, { _id: 101, n: 101 }]'
    )
    await expect(page.getByTestId('insert-count')).toHaveText('2 documents')
    await page.getByTestId('insert-submit').click()
    await expect(page.getByTestId('result-count')).toHaveText('8 documents')
    expect(
      (await shop()
        .collection('bulk')
        .findOne({ _id: 100 as never }, { promoteValues: false }))!['n']._bsontype
    ).toBe('Long')

    // Clone the first document (without its _id).
    const first = page.getByTestId('json-tree').first()
    await first.hover()
    await first.getByTestId('doc-clone').click()
    await expect(page.getByTestId('insert-editor')).not.toContainText('_id')
    await page.getByTestId('insert-submit').click()
    await expect(page.getByTestId('result-count')).toHaveText('9 documents')

    // Delete one.
    await first.hover()
    await first.getByTestId('doc-delete').click()
    await page.getByTestId('confirm-button').click()
    await expect(page.getByTestId('result-count')).toHaveText('8 documents')
    expect(
      await shop()
        .collection('bulk')
        .countDocuments({ _id: 0 as never })
    ).toBe(0)

    // Bulk update with a preview, scoped by the current filter.
    const filter = page.getByTestId('filter-editor')
    await replaceText(page, filter, '{ tag: "x" }')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByTestId('result-count')).toHaveText('6 documents')
    await page.getByTestId('more-actions').click()
    await page.getByTestId('bulk-update').click()
    await replaceText(
      page,
      page.getByTestId('bulk-update-editor'),
      '{ $inc: { n: 1000 }, $set: { tag: "y" } }'
    )
    await expect(page.getByTestId('preview-item')).toHaveCount(5)
    await expect(page.getByTestId('preview-after').first()).toContainText('tag: "y"')
    expect(await shop().collection('bulk').countDocuments({ tag: 'y' })).toBe(0) // preview never writes
    await page.getByTestId('bulk-update-submit').click()
    await page.getByTestId('confirm-button').click()
    await expect.poll(() => shop().collection('bulk').countDocuments({ tag: 'y' })).toBe(6)

    // Bulk delete everything matching the (re-run) filter, with typed confirmation.
    await replaceText(page, filter, '{ tag: "y" }')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByTestId('result-count')).toHaveText('6 documents')
    await page.getByTestId('more-actions').click()
    await page.getByTestId('bulk-delete').click()
    await expect(page.getByTestId('confirm-button')).toBeDisabled()
    await page.getByTestId('confirm-input').fill('6')
    await page.getByTestId('confirm-button').click()
    await expect.poll(() => shop().collection('bulk').countDocuments()).toBe(2)
  } finally {
    await app.close()
  }
})

test('read-only mode and views disable every write action', async () => {
  await shop()
    .collection('ro')
    .insertOne({ _id: 1 as never, a: 1 })
  await shop().createCollection('roview', { viewOn: 'ro', pipeline: [] })
  const { app, page } = await launchApp()
  try {
    await open(page, 'ro')
    await page.getByTestId('permissions-button').click()
    await page.getByTestId('readonly-switch').click()
    await page.keyboard.press('Escape')
    const tree = page.getByTestId('json-tree').first()
    await tree.hover()
    for (const id of ['doc-edit', 'doc-edit-json', 'doc-clone', 'doc-delete'])
      await expect(tree.getByTestId(id)).toBeDisabled()
    await expect(page.getByTestId('insert-button')).toBeDisabled()
    await page.getByTestId('tab-lock').click() // read-only off again

    await page.getByTestId('coll-shop.roview').click()
    const viewTree = page.getByTestId('json-tree').first()
    await viewTree.hover()
    await expect(viewTree.getByTestId('doc-edit')).toBeDisabled()
    await expect(page.getByTestId('insert-button')).toHaveAttribute('title', /Views are read-only/)
  } finally {
    await app.close()
  }
})

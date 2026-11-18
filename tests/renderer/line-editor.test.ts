import { describe, expect, it, vi } from 'vitest'
import { LineEditor, type LineEditorHost } from '../../src/renderer/src/features/shell/line-editor'
import { formatShellResult, isIncompleteInput } from '../../src/shared/shell-output'
import { Long, ObjectId } from 'bson'

function setup(history: string[] = [], completions: string[] = []) {
  const ran: string[] = []
  const written: string[] = []
  const host: LineEditorHost = {
    run: vi.fn(async (code: string) => void ran.push(code)),
    interrupt: vi.fn(),
    complete: vi.fn(async () => completions),
    onHistory: vi.fn()
  }
  const ed = new LineEditor({ write: (d) => void written.push(d), cols: 80 }, host, history)
  ed.setPrompt('shop> ')
  ed.showPrompt()
  return { ed, host, ran, written }
}

const LEFT = '\u001b[D'
const UP = '\u001b[A'
const DOWN = '\u001b[B'

describe('LineEditor', () => {
  it('runs a line on Enter', async () => {
    const { ed, ran } = setup()
    await ed.handle('db.orders.find()\r')
    expect(ran).toEqual(['db.orders.find()'])
  })

  it('edits in the middle of a line, with backspace and word delete', async () => {
    const { ed, ran } = setup()
    await ed.handle('db.ordrs')
    await ed.handle(LEFT + LEFT)
    await ed.handle('e')
    await ed.handle('\u001b[F.find(x)\u007f\u007f)')
    await ed.handle('\r')
    expect(ran).toEqual(['db.orders.find()'])
    await ed.handle('a b c\u0017\r')
    expect(ran.at(-1)).toBe('a b')
  })

  it('continues multi-line input until brackets close', async () => {
    const { ed, ran, written } = setup()
    await ed.handle('db.orders.aggregate([\r')
    expect(ran).toEqual([])
    expect(written.join('')).toContain('... ')
    await ed.handle('  { $match: { a: 1 } }\r])\r')
    expect(ran).toEqual(['db.orders.aggregate([\n  { $match: { a: 1 } }\n])'])
  })

  it('pasted multi-line text runs as one command', async () => {
    const { ed, ran } = setup()
    await ed.handle('db.orders.find({\r  a: 1\r})\r')
    expect(ran).toEqual(['db.orders.find({\n  a: 1\n})'])
  })

  it('walks history with up/down and restores the draft', async () => {
    const { ed, ran } = setup(['first', 'second'])
    await ed.handle('dra')
    await ed.handle(UP)
    await ed.handle(UP)
    await ed.handle('\r')
    expect(ran).toEqual(['first'])
    await ed.handle('xy' + UP + DOWN + '\r')
    expect(ran.at(-1)).toBe('xy')
  })

  it('Ctrl+C abandons the input at the prompt and interrupts while running', async () => {
    const { ed, host, ran } = setup()
    await ed.handle('half typed\u0003')
    await ed.handle('ok\r')
    expect(ran).toEqual(['ok'])

    let release!: () => void
    ;(host.run as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((r) => (release = r))
    )
    const running = ed.handle('long()\r')
    await Promise.resolve()
    expect(ed.busy).toBe(true)
    await ed.handle('\u0003')
    expect(host.interrupt).toHaveBeenCalled()
    release()
    await running
    expect(ed.busy).toBe(false)
  })

  it('Tab completes the common prefix', async () => {
    const { ed, ran } = setup([], ['db.orders.find', 'db.orders.findOne'])
    await ed.handle('db.orders.fi\t')
    await ed.handle('(\r')
    expect(ran).toEqual([]) // "find(" is still open: Enter continues the command
    await ed.handle(')\r')
    expect(ran).toEqual(['db.orders.find(\n)'])
  })

  it('Tab completes the last token', async () => {
    const { ed, ran } = setup([], ['orders'])
    await ed.handle('const c = db.getCollection(ord\t')
    await ed.handle(')\r')
    expect(ran).toEqual(['const c = db.getCollection(orders)'])
  })
})

describe('isIncompleteInput', () => {
  it('detects open brackets, strings, comments and trailing operators', () => {
    expect(isIncompleteInput('db.x.find({')).toBe(true)
    expect(isIncompleteInput('db.x.find({ a: "}" })')).toBe(false)
    expect(isIncompleteInput('`multi')).toBe(true)
    expect(isIncompleteInput('/* comment')).toBe(true)
    expect(isIncompleteInput('db.x.')).toBe(true)
    expect(isIncompleteInput('i++')).toBe(false)
    expect(isIncompleteInput('use shop')).toBe(false)
  })
})

describe('formatShellResult', () => {
  it('prints cursors like mongosh, with "it" when there is more', () => {
    const out = formatShellResult(
      'Cursor',
      {
        documents: [
          { _id: new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9'), n: Long.fromString('9007199254740993') }
        ],
        cursorHasMore: true
      },
      false
    )
    expect(out).toContain('_id: ObjectId("65f1c0a1b2c3d4e5f6a7b8c9")')
    expect(out).toContain('NumberLong("9007199254740993")')
    expect(out.endsWith('Type "it" for more')).toBe(true)
    expect(formatShellResult('CursorIterationResult', { documents: [], cursorHasMore: false }, false)).toBe(
      'no cursor'
    )
  })

  it('formats show dbs / show collections and plain values', () => {
    expect(
      formatShellResult(
        'ShowDatabasesResult',
        [
          { name: 'admin', sizeOnDisk: 40960 },
          { name: 'shop', sizeOnDisk: 2048 }
        ],
        false
      )
    ).toBe('admin  40.00 KiB\nshop   2.00 KiB')
    expect(formatShellResult('ShowCollectionsResult', [{ name: 'orders', badge: '' }], false)).toBe('orders')
    expect(formatShellResult(null, 'switched to db other', false)).toBe('switched to db other')
    expect(formatShellResult(null, undefined, false)).toBe('')
    expect(formatShellResult('InspectResult', '[Function: f]', false)).toBe('[Function: f]')
  })

  it('colours values for the terminal', () => {
    const out = formatShellResult(null, { a: 'x', n: 1 }, true)
    expect(out).toContain('\u001b[32m"x"')
    expect(out).toContain('\u001b[33m1')
  })
})

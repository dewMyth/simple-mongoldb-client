import { describe, expect, it } from 'vitest'
import { Decimal128, Int32, Long, ObjectId } from 'bson'
import { JsonDocumentSplitter } from '../../src/main/services/import-export/json-stream'
import {
  CsvReader,
  convertCell,
  csvCell,
  csvRow,
  csvValue,
  detectColumnType,
  rowToDocument,
  valueAtPath
} from '../../src/main/services/import-export/csv'

/** Feeds text in chunks of every size from 1 to 64 to check boundary handling. */
function splitAll(text: string, size: number): string[] {
  const s = new JsonDocumentSplitter()
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(...s.feed(text.slice(i, i + size)))
  out.push(...s.end())
  return out
}

describe('JsonDocumentSplitter', () => {
  const docs = [
    '{"a":1}',
    '{"s":"x, ] } { \\" [","n":{"m":[1,2,{"k":"]"}]}}',
    '{"e":{"$numberLong":"9007199254740993"}}'
  ]

  it('splits a JSON array at any chunk boundary', () => {
    const text = `\uFEFF[\n  ${docs.join(',\n  ')}\n]\n`
    for (let size = 1; size <= 64; size++)
      expect(splitAll(text, size).map((t) => JSON.parse(t))).toEqual(docs.map((d) => JSON.parse(d)))
  })

  it('splits JSON lines and concatenated documents', () => {
    for (let size = 1; size <= 64; size++) {
      expect(splitAll(docs.join('\n') + '\n', size)).toEqual(docs)
      expect(splitAll(docs.join(''), size)).toEqual(docs)
    }
  })

  it('ends a malformed JSON line at its newline, so the next line still parses', () => {
    expect(splitAll('{"a":1}\nnot json\n[1,2]\n{"b":2}\n', 3)).toEqual([
      '{"a":1}',
      'not json',
      '[1,2]',
      '{"b":2}'
    ])
  })

  it('handles empty arrays and a trailing comma', () => {
    expect(splitAll('[]', 4)).toEqual([])
    expect(splitAll('[{"a":1},]', 3)).toEqual(['{"a":1}'])
  })

  it('reports incomplete input', () => {
    expect(() => splitAll('[{"a":1}', 5)).toThrow(/isn’t closed/)
    expect(() => splitAll('{"a":"x', 5)).toThrow(/inside a string/)
    expect(() => splitAll('[] junk', 5)).toThrow(/after the end/)
  })
})

describe('CSV', () => {
  const text = 'name,note,n\r\nAda,"Hello, ""world""",1\nBob,"multi\nline",2\n"",x,\n'

  it('reads quoted fields, escaped quotes, quoted newlines and CRLF at any chunk size', () => {
    for (let size = 1; size <= 40; size++) {
      const r = new CsvReader()
      const rows: string[][] = []
      for (let i = 0; i < text.length; i += size) rows.push(...r.feed(text.slice(i, i + size)))
      rows.push(...r.end())
      expect(rows).toEqual([
        ['name', 'note', 'n'],
        ['Ada', 'Hello, "world"', '1'],
        ['Bob', 'multi\nline', '2'],
        ['', 'x', '']
      ])
    }
  })

  it('writes cells that round-trip through the reader', () => {
    const cells = ['plain', 'a,b', 'q"uote', 'new\nline', ' pad ']
    const line = cells.map(csvCell).join(',') + '\n'
    expect(new CsvReader().feed(line)).toEqual([cells])
  })

  it('flattens documents to dotted columns, arrays and objects as relaxed EJSON', () => {
    const doc = {
      _id: new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9'),
      customer: { name: 'Ada', tags: ['a', 'b'] },
      items: [{ sku: 'X' }, { sku: 'Y' }],
      n: new Int32(5),
      big: Long.fromString('9007199254740993'),
      price: Decimal128.fromString('9.99'),
      when: new Date('2026-01-02T03:04:05Z')
    }
    expect(valueAtPath(doc, 'items.sku')).toEqual(['X', 'Y'])
    expect(
      csvRow(doc, [
        '_id',
        'customer.name',
        'customer.tags',
        'items.sku',
        'n',
        'big',
        'price',
        'when',
        'missing'
      ])
    ).toBe(
      '65f1c0a1b2c3d4e5f6a7b8c9,Ada,"[""a"",""b""]","[""X"",""Y""]",5,9007199254740993,9.99,2026-01-02T03:04:05.000Z,'
    )
    expect(csvValue(null)).toBe('')
  })

  it('detects column types from samples', () => {
    expect(detectColumnType(['1', '2', ''])).toBe('int32')
    expect(detectColumnType(['1', '9007199254740993'])).toBe('int64')
    expect(detectColumnType(['1', '2.5'])).toBe('double')
    expect(detectColumnType(['true', 'FALSE'])).toBe('boolean')
    expect(detectColumnType(['2026-01-02', '2026-01-02T03:04:05Z'])).toBe('date')
    expect(detectColumnType(['65f1c0a1b2c3d4e5f6a7b8c9'])).toBe('objectId')
    expect(detectColumnType(['1', 'x'])).toBe('string')
  })

  it('converts cells to exact types, with readable errors', () => {
    expect(convertCell('42', 'int32', true)).toEqual(new Int32(42))
    expect(String(convertCell('9007199254740993', 'int64', true))).toBe('9007199254740993')
    expect(String(convertCell('0.10', 'decimal128', true))).toBe('0.10')
    expect(convertCell('yes', 'boolean', true)).toBe(true)
    expect(convertCell('', 'int32', true)).toBeUndefined()
    expect(convertCell('', 'string', false)).toBe('')
    expect(convertCell('', 'string', true)).toBeUndefined()
    expect(() => convertCell('2147483648', 'int32', true)).toThrow(/Int32/)
    expect(() => convertCell('99999999999999999999', 'int64', true)).toThrow(/Int64/)
    expect(() => convertCell('nope', 'date', true)).toThrow(/date/)
  })

  it('builds nested documents from dotted headers', () => {
    expect(rowToDocument(['a.b', 'a.c', 'x'], ['int32', 'string', 'exclude'], ['1', 'y', 'z'], true)).toEqual(
      {
        a: { b: new Int32(1), c: 'y' }
      }
    )
  })
})

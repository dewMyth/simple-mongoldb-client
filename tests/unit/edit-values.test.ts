import { describe, expect, it } from 'vitest'
import { Binary, BSONRegExp, Decimal128, Double, Int32, Long, ObjectId, Timestamp, UUID } from 'bson'
import { bsonTypeOf } from '../../src/shared/bson-types'
import { convertValue, editableTypes, editText, parseEditValue } from '../../src/shared/edit-values'

const ok = (r: ReturnType<typeof parseEditValue>) => {
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('editText ↔ parseEditValue round trip', () => {
  const samples: unknown[] = [
    'hello',
    new Int32(-7),
    Long.fromString('9007199254740993'),
    new Double(10),
    new Double(3.25),
    Decimal128.fromString('10.50'),
    true,
    new Date('1969-07-20T20:17:40.123Z'),
    new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9'),
    null,
    new Binary(new Uint8Array([0, 1, 2, 255]), 0),
    new UUID('3b241101-e2bb-4255-8caf-4136c566a962').toBinary(),
    new Timestamp({ t: 1700000000, i: 3 }),
    new BSONRegExp('a.b', 'imsx')
  ]
  for (const v of samples) {
    const tag = bsonTypeOf(v)
    it(tag, () => {
      const back = ok(parseEditValue(editText(v), tag, v))
      expect(bsonTypeOf(back)).toBe(tag)
      expect(editText(back)).toBe(editText(v))
    })
  }
})

describe('parseEditValue validation', () => {
  it('rejects values that do not fit the type', () => {
    expect(parseEditValue('abc', 'int32').ok).toBe(false)
    expect(parseEditValue('2147483648', 'int32').ok).toBe(false)
    expect(parseEditValue('1.5', 'int64').ok).toBe(false)
    expect(parseEditValue('9223372036854775808', 'int64').ok).toBe(false)
    expect(parseEditValue('nope', 'decimal128').ok).toBe(false)
    expect(parseEditValue('2026-13-45', 'date').ok).toBe(false)
    expect(parseEditValue('xyz', 'objectId').ok).toBe(false)
    expect(parseEditValue('maybe', 'boolean').ok).toBe(false)
    expect(parseEditValue('not-a-uuid', 'uuid').ok).toBe(false)
  })

  it('keeps Decimal128 precision exactly', () => {
    expect(editText(ok(parseEditValue('12345678901234567890.123456789', 'decimal128')))).toBe(
      '12345678901234567890.123456789'
    )
  })

  it('keeps a binary subtype when editing', () => {
    const v = ok(parseEditValue('AAEC', 'binary', new Binary(new Uint8Array([9]), 128))) as Binary
    expect(v.sub_type).toBe(128)
  })
})

describe('convertValue (type dropdown)', () => {
  it('converts when the value fits', () => {
    expect(bsonTypeOf(ok(convertValue('42', 'int32')))).toBe('int32')
    expect(editText(ok(convertValue(new Int32(42), 'int64')))).toBe('42')
    expect(bsonTypeOf(ok(convertValue(new Int32(42), 'double')))).toBe('double')
    expect(editText(ok(convertValue(new Double(1.5), 'decimal128')))).toBe('1.5')
    expect(ok(convertValue(new Int32(1), 'string'))).toBe('1')
    expect(ok(convertValue('anything', 'null'))).toBeNull()
    expect(ok(convertValue('x', 'object'))).toEqual({})
    expect(ok(convertValue('x', 'array'))).toEqual([])
  })

  it('explains when it cannot', () => {
    const r = convertValue('hello', 'int32')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/Int32/)
    expect(convertValue(new Double(1.5), 'int32').ok).toBe(false)
  })

  it('offers the types listed in the plan', () => {
    expect(editableTypes).toEqual([
      'string',
      'int32',
      'int64',
      'double',
      'decimal128',
      'boolean',
      'date',
      'objectId',
      'null',
      'object',
      'array',
      'binary',
      'uuid',
      'timestamp',
      'regex'
    ])
  })
})

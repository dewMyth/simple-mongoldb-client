import { describe, expect, it } from 'vitest'
import { BSON } from 'bson'
import { fromBsonBytes, ownBytes, receivedSize, toBsonBytes } from '../../src/shared/bson-wire'
import { allTypesDoc } from '../fixtures/all-types'

describe('BSON wire format', () => {
  it('round-trips every BSON type byte-for-byte, through a structured clone (the IPC copy)', () => {
    const doc = allTypesDoc()
    const wire = structuredClone(toBsonBytes(doc))
    const back = fromBsonBytes(wire)
    expect(Buffer.from(BSON.serialize(back)).equals(Buffer.from(BSON.serialize(doc)))).toBe(true)
    expect(receivedSize(back)).toBe(wire.byteLength)
  })

  it('keeps BSON classes instead of promoting to JS numbers', () => {
    const back = fromBsonBytes(toBsonBytes(allTypesDoc()))
    expect((back['int32'] as { _bsontype: string })._bsontype).toBe('Int32')
    expect((back['doubleWhole'] as { _bsontype: string })._bsontype).toBe('Double')
    expect((back['int64'] as { _bsontype: string })._bsontype).toBe('Long')
    expect((back['regexFlags'] as { _bsontype: string })._bsontype).toBe('BSONRegExp')
  })

  it('ownBytes detaches a view from its larger backing buffer', () => {
    const big = new Uint8Array(1024)
    const view = big.subarray(100, 110)
    const owned = ownBytes(view)
    expect(owned.buffer.byteLength).toBe(10)
    expect(structuredClone(view).buffer.byteLength).toBe(1024) // why ownBytes exists
  })
})

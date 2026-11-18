import { describe, expect, it } from 'vitest'
import { serialize } from 'bson'
import { fromCanonical, toCanonical } from '../../src/shared/ejson'
import { allTypesDoc } from '../fixtures/all-types'

describe('canonical EJSON round trip', () => {
  it('keeps every BSON type byte-identical through a JSON (structured-clone-like) hop', () => {
    const doc = allTypesDoc()
    // Simulate IPC: canonical EJSON is plain JSON, so stringify/parse is a faithful stand-in.
    const wire = JSON.parse(JSON.stringify(toCanonical(doc)))
    const back = fromCanonical(wire)
    expect(Buffer.from(serialize(back)).equals(Buffer.from(serialize(doc)))).toBe(true)
  })
})

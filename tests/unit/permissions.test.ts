import { describe, expect, it } from 'vitest'
import { can, resourceMatches, type PermissionSnapshot, type Privilege } from '../../src/shared/permissions'

function snap(p: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    connectionId: 'c',
    mode: 'privileges',
    users: [{ user: 'alice', db: 'admin' }],
    roles: [],
    privileges: [],
    readOnlyOverride: false,
    secondaryReason: null,
    denied: [],
    statusError: null,
    ...p
  }
}

describe('resourceMatches', () => {
  it('exact namespace', () => {
    expect(resourceMatches({ db: 'shop', collection: 'orders' }, 'shop.orders')).toBe(true)
    expect(resourceMatches({ db: 'shop', collection: 'orders' }, 'shop.users')).toBe(false)
  })
  it('collection wildcard covers non-system collections only', () => {
    expect(resourceMatches({ db: 'shop', collection: '' }, 'shop.orders')).toBe(true)
    expect(resourceMatches({ db: 'shop', collection: '' }, 'shop.system.profile')).toBe(false)
    expect(resourceMatches({ db: 'shop', collection: '' }, 'other.orders')).toBe(false)
  })
  it('db wildcard', () => {
    expect(resourceMatches({ db: '', collection: 'orders' }, 'any.orders')).toBe(true)
    expect(resourceMatches({ db: '', collection: '' }, 'any.thing')).toBe(true)
  })
  it('db-level checks only match a collection wildcard', () => {
    expect(resourceMatches({ db: 'shop', collection: '' }, 'shop')).toBe(true)
    expect(resourceMatches({ db: 'shop', collection: 'orders' }, 'shop')).toBe(false)
  })
  it('anyResource and cluster', () => {
    expect(resourceMatches({ anyResource: true }, 'x.system.users')).toBe(true)
    expect(resourceMatches({ cluster: true }, 'x.y')).toBe(false)
  })
  it('collection names with dots', () => {
    expect(resourceMatches({ db: 'shop', collection: 'a.b' }, 'shop.a.b')).toBe(true)
  })
})

describe('can', () => {
  const readShop: Privilege[] = [
    { resource: { db: 'shop', collection: '' }, actions: ['find', 'listCollections'] }
  ]

  it('enforces the privilege matrix with a readable reason', () => {
    const s = snap({ privileges: readShop })
    expect(can(s, 'shop.orders', 'find')).toEqual({ allowed: true })
    const denied = can(s, 'shop.orders', 'update')
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('alice lacks `update` on `shop.orders`.')
  })

  it('no-auth and optimistic modes allow everything not yet denied', () => {
    expect(can(snap({ mode: 'noAuth' }), 'a.b', 'dropDatabase').allowed).toBe(true)
    const s = snap({
      mode: 'optimistic',
      denied: [{ ns: 'a.b', action: 'insert', message: 'Server said no' }]
    })
    expect(can(s, 'a.b', 'insert')).toEqual({ allowed: false, reason: 'Server said no' })
    expect(can(s, 'a.c', 'insert').allowed).toBe(true)
  })

  it('a db-level denial covers its collections', () => {
    const s = snap({ mode: 'noAuth', denied: [{ ns: 'shop', action: 'createCollection', message: 'no' }] })
    expect(can(s, 'shop.new', 'createCollection').allowed).toBe(false)
  })

  it('read-only override and secondaries block writes but not reads, and never grant', () => {
    const ro = snap({ mode: 'noAuth', readOnlyOverride: true })
    expect(can(ro, 'a.b', 'insert').reason).toMatch(/Read-only mode/)
    expect(can(ro, 'a.b', 'find').allowed).toBe(true)
    const sec = snap({ mode: 'noAuth', secondaryReason: 'Connected to a secondary.' })
    expect(can(sec, 'a', 'dropDatabase')).toEqual({ allowed: false, reason: 'Connected to a secondary.' })
    // Read-only can't add privileges the user doesn't have.
    expect(can(snap({ readOnlyOverride: true }), 'a.b', 'find').allowed).toBe(false)
  })

  it('denies when not connected', () => {
    expect(can(null, 'a.b', 'find').allowed).toBe(false)
  })
})

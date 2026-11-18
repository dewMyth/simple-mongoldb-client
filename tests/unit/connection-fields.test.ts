import { describe, expect, it } from 'vitest'
import {
  fieldsToUri,
  redactUri,
  setPassword,
  stripPassword,
  uriToFields,
  validateUri
} from '../../src/shared/connection-fields'

describe('connection string <-> fields', () => {
  it('parses a full SCRAM replica set URI', () => {
    const f = uriToFields(
      'mongodb://alice:p%40ss@h1:27017,h2:27018/shop?replicaSet=rs0&authSource=admin&readPreference=secondary&tls=true&tlsCAFile=%2Fca.pem&appName=x'
    )
    expect(f).toMatchObject({
      scheme: 'mongodb',
      hosts: ['h1:27017', 'h2:27018'],
      authMechanism: 'DEFAULT',
      username: 'alice',
      password: 'p@ss',
      authSource: 'admin',
      defaultDatabase: 'shop',
      replicaSet: 'rs0',
      readPreference: 'secondary',
      tls: 'on',
      tlsCAFile: '/ca.pem',
      appName: 'x'
    })
  })

  it('round-trips fields -> uri -> fields', () => {
    const uri =
      'mongodb://bob:s%3Acr%2Fet@db.example.com:27017/?authSource=admin&tls=true&tlsAllowInvalidCertificates=true&directConnection=true'
    const fields = uriToFields(uri)
    expect(uriToFields(fieldsToUri(fields, uri))).toEqual(fields)
  })

  it('preserves parameters the form does not know about', () => {
    const uri = 'mongodb://localhost:27017/?retryWrites=false&w=majority&compressors=zstd'
    const out = fieldsToUri({ ...uriToFields(uri), appName: 'Studio' }, uri)
    expect(out).toContain('retryWrites=false')
    expect(out).toContain('w=majority')
    expect(out).toContain('compressors=zstd')
    expect(out).toContain('appName=Studio')
  })

  it('switches between mongodb and mongodb+srv', () => {
    const base = 'mongodb://a:1,b:2/?replicaSet=rs'
    const srv = fieldsToUri(
      { ...uriToFields(base), scheme: 'mongodb+srv', hosts: ['cluster0.x.mongodb.net:27017'] },
      base
    )
    expect(srv).toMatch(/^mongodb\+srv:\/\/cluster0\.x\.mongodb\.net\//)
    expect(srv).toContain('replicaSet=rs')
    expect(validateUri(srv)).toBeNull()
  })

  it('X.509 keeps the username but never a password', () => {
    const f = {
      ...uriToFields('mongodb://localhost'),
      authMechanism: 'MONGODB-X509' as const,
      username: 'CN=me',
      password: 'x'
    }
    const uri = fieldsToUri(f)
    expect(uri).toContain('authMechanism=MONGODB-X509')
    expect(uri).toContain('CN%3Dme@')
    expect(uri).not.toContain(':x@')
  })

  it('removes credentials when auth is set to none', () => {
    const uri = 'mongodb://u:p@localhost/?authSource=admin'
    expect(fieldsToUri({ ...uriToFields(uri), authMechanism: 'none' }, uri)).toBe('mongodb://localhost/')
  })

  it('strips and restores passwords', () => {
    const { uri, password } = stripPassword('mongodb://u:p%40ss%3A1@h/db?tls=true')
    expect(password).toBe('p@ss:1')
    expect(uri).toBe('mongodb://u@h/db?tls=true')
    expect(uriToFields(setPassword(uri, password)).password).toBe('p@ss:1')
  })

  it('redacts', () => {
    expect(redactUri('mongodb://u:secret@h/')).not.toContain('secret')
  })

  it('validates', () => {
    expect(validateUri('http://x')).toMatch(/must start with/)
    expect(validateUri('mongodb+srv://a.b.c:27017')).toMatch(/port/)
    expect(validateUri('mongodb://localhost:27017')).toBeNull()
  })
})

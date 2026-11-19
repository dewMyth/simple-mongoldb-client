import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileLog, redact, uriHosts } from '../../src/main/services/log'

const dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ms-log-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('redact', () => {
  it('removes credentials from connection strings', () => {
    expect(redact('mongodb+srv://alice:s3cr%40t@cluster0.example.net/shop?retryWrites=true')).toBe(
      'mongodb+srv://<credentials>@cluster0.example.net/shop?retryWrites=true'
    )
    expect(redact('failed mongodb://bob@h1:27017,h2:27018/?replicaSet=rs')).toBe(
      'failed mongodb://<credentials>@h1:27017,h2:27018/?replicaSet=rs'
    )
  })

  it('removes secret-looking options and fields', () => {
    expect(redact('mongodb://h/?tlsCertificateKeyFilePassword=abc&authSource=admin')).toBe(
      'mongodb://h/?tlsCertificateKeyFilePassword=<redacted>&authSource=admin'
    )
    expect(redact('{"password":"hunter2","sshPassphrase": "x y"}')).toBe(
      '{"password":"<redacted>","sshPassphrase": "<redacted>"}'
    )
  })

  it('uriHosts keeps only the hosts', () => {
    expect(uriHosts('mongodb://u:p@a:1,b:2/db?x=1')).toBe('a:1,b:2')
    expect(uriHosts('mongodb+srv://u:p@cluster.example.net/')).toBe('srv:cluster.example.net')
    expect(uriHosts('nonsense')).toBe('<unparsed>')
  })
})

describe('FileLog', () => {
  it('writes redacted lines with fields and errors', () => {
    const dir = tempDir()
    const log = new FileLog(dir)
    log.write('info', 'connected', { id: 'c1', hosts: 'a:1', ssh: false })
    log.write('error', 'uncaught exception', {}, new Error('boom at mongodb://u:pw@h'))
    const text = readFileSync(join(dir, 'main.log'), 'utf8')
    expect(text).toMatch(/^\S+Z INFO  connected id="c1" hosts="a:1" ssh=false\n/)
    expect(text).toContain('Error: boom at mongodb://<credentials>@h')
    expect(text).not.toContain('pw')
  })

  it('rotates at the size limit and keeps a fixed number of files', () => {
    const dir = tempDir()
    const log = new FileLog(dir, 200, 3)
    for (let i = 0; i < 40; i++) log.write('info', `line ${i} ${'x'.repeat(40)}`)
    expect(readdirSync(dir).sort()).toEqual(['main.1.log', 'main.2.log', 'main.log'])
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toContain('line 39')
  })
})

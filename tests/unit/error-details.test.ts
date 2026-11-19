import { describe, expect, it } from 'vitest'
import { errorDetails } from '../../src/shared/error-details'

const info = {
  name: 'Mongo Studio',
  version: '1.2.3',
  electron: '45',
  chrome: '140',
  node: '22',
  platform: 'darwin arm64'
}

describe('errorDetails', () => {
  it('includes the message, server code and app version', () => {
    const text = errorDetails(
      'not authorized on shop',
      { name: 'MongoServerError', message: 'not authorized on shop', code: 13, codeName: 'Unauthorized' },
      info
    )
    expect(text.split('\n')).toEqual([
      'not authorized on shop',
      'Error: MongoServerError',
      'Code: 13 (Unauthorized)',
      'App: Mongo Studio 1.2.3',
      'Electron 45 · Chrome 140 · Node 22 · darwin arm64'
    ])
  })

  it('works with only a message, and keeps a different underlying message and the stack', () => {
    expect(errorDetails('Boom', undefined, null)).toBe('Boom')
    const err = new TypeError('x is undefined')
    const text = errorDetails('Render error in document', err, null)
    expect(text).toContain('Message: x is undefined')
    expect(text).toContain('Error: TypeError')
    expect(text).toContain(err.stack!)
  })
})

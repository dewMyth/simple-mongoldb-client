import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

const { wrapHandler, serializeError } = await import('../../src/main/ipc/router')

const fakeEvent = {} as never

describe('ipc router', () => {
  it('validates input with zod before calling the handler', async () => {
    const handler = vi.fn()
    const res = await wrapHandler('settings:setTheme', handler)(fakeEvent, 'purple')
    expect(res.ok).toBe(false)
    expect(!res.ok && res.error.validation).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })

  it('passes parsed input and returns data', async () => {
    const res = await wrapHandler('settings:setTheme', (theme) => ({ theme }))(fakeEvent, 'dark')
    expect(res).toEqual({ ok: true, data: { theme: 'dark' } })
  })

  it('keeps MongoServerError codes', () => {
    const err = Object.assign(new Error('not authorized on shop'), {
      code: 13,
      codeName: 'Unauthorized',
      name: 'MongoServerError'
    })
    expect(serializeError(err)).toEqual({
      name: 'MongoServerError',
      message: 'not authorized on shop',
      code: 13,
      codeName: 'Unauthorized'
    })
  })
})

import { defaultSettings } from '../../src/shared/settings'
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
    const res = await wrapHandler('settings:setTheme', (theme) => ({ ...defaultSettings, theme }))(
      fakeEvent,
      'dark'
    )
    expect(res).toEqual({ ok: true, data: { ...defaultSettings, theme: 'dark' } })
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

describe('settings', () => {
  it('fill defaults and drop invalid stored values', async () => {
    const { normalizeSettings } = await import('../../src/shared/settings')
    expect(normalizeSettings({ theme: 'dark', fontSize: 99, sampleSize: 500, extra: 1 })).toEqual({
      ...defaultSettings,
      theme: 'dark',
      sampleSize: 500
    })
    expect(normalizeSettings(null)).toEqual(defaultSettings)
  })

  it('validates partial updates at the IPC boundary', async () => {
    const ok = await wrapHandler('settings:update', (patch) => ({ ...defaultSettings, ...patch }))(
      fakeEvent,
      { fontSize: 14 }
    )
    expect(ok).toMatchObject({ ok: true, data: { fontSize: 14 } })
    const bad = await wrapHandler('settings:update', (patch) => ({ ...defaultSettings, ...patch }))(
      fakeEvent,
      { fontSize: 99 }
    )
    expect(bad).toMatchObject({ ok: false, error: { validation: true } })
  })
})

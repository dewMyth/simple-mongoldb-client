import { describe, expect, it } from 'vitest'
import { pageWindow, resultTotal } from '../../src/shared/query'

describe('pageWindow', () => {
  it('pages without user skip/limit', () => {
    expect(pageWindow({}, { offset: 0, size: 25 })).toEqual({ skip: 0, limit: 25 })
    expect(pageWindow({}, { offset: 50, size: 25 })).toEqual({ skip: 50, limit: 25 })
  })
  it('adds the user skip', () => {
    expect(pageWindow({ skip: 10 }, { offset: 25, size: 25 })).toEqual({ skip: 35, limit: 25 })
  })
  it('never reads past the user limit', () => {
    expect(pageWindow({ limit: 60 }, { offset: 50, size: 25 })).toEqual({ skip: 50, limit: 10 })
    expect(pageWindow({ limit: 50 }, { offset: 50, size: 25 })).toBeNull()
  })
})

describe('resultTotal', () => {
  it('applies skip and limit to the filter count', () => {
    expect(resultTotal(300, {})).toBe(300)
    expect(resultTotal(300, { skip: 290 })).toBe(10)
    expect(resultTotal(300, { skip: 400 })).toBe(0)
    expect(resultTotal(300, { limit: 60 })).toBe(60)
    expect(resultTotal(300, { skip: 280, limit: 60 })).toBe(20)
  })
})

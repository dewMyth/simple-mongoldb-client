import { describe, expect, it } from 'vitest'
import { BSON, type Document } from 'bson'
import { stagesToText, textToStages } from '../../src/shared/pipeline'
import { parseShellValue } from '../../src/main/services/query-parser'
import { stageFixtures, textFixtures } from '../fixtures/pipelines'

const bytes = (pipeline: unknown[]) => Buffer.from(BSON.serialize({ p: pipeline })).toString('hex')

function parseStages(stages: { operator: string; body: string; enabled: boolean }[]): Document[] {
  return stages
    .filter((s) => s.enabled)
    .map((s) => {
      const r = parseShellValue(s.body)
      if (!r.ok) throw new Error(`${s.operator}: ${r.error.message}`)
      return { [s.operator]: r.value }
    })
}

describe('Done when: text ↔ stage mode conversion round-trips the fixture pipelines exactly', () => {
  for (const f of stageFixtures) {
    it(`stages → text → stages: ${f.name}`, () => {
      const text = stagesToText(f.stages)
      const back = textToStages(text)
      if (!back.ok) throw new Error(back.error)
      expect(back.stages).toEqual(f.stages)
      // ...and the text is stable: converting again gives the same text.
      expect(stagesToText(back.stages)).toBe(text)
    })
  }

  it('the text form is a valid pipeline with the same BSON as the stages', () => {
    for (const f of stageFixtures) {
      if (f.stages.some((s) => s.enabled && !s.body)) continue
      const whole = parseShellValue(stagesToText(f.stages))
      if (!whole.ok) throw new Error(`${f.name}: ${whole.error.message}`)
      expect(bytes(whole.value as unknown[])).toBe(bytes(parseStages(f.stages)))
    }
  })

  for (const [i, text] of textFixtures.entries()) {
    it(`hand-written text keeps its meaning (#${i + 1})`, () => {
      const r = textToStages(text)
      if (!r.ok) throw new Error(r.error)
      const whole = parseShellValue(text)
      if (!whole.ok) throw new Error(whole.error.message)
      expect(bytes(parseStages(r.stages))).toBe(bytes(whole.value as unknown[]))
      // Once in the canonical layout it's stable.
      const canonical = stagesToText(r.stages)
      const again = textToStages(canonical)
      expect(again.ok && again.stages).toEqual(r.stages)
    })
  }

  it('lays out stages as an indented array, commenting out disabled ones', () => {
    expect(
      stagesToText([
        { operator: '$match', body: '{\n  a: 1\n}', enabled: true },
        { operator: '$limit', body: '5', enabled: false },
        { operator: '$sort', body: '{ a: -1 }', enabled: true }
      ])
    ).toBe('[\n  { $match: {\n    a: 1\n  } },\n  // { $limit: 5 }\n  { $sort: { a: -1 } }\n]')
  })
})

describe('textToStages errors', () => {
  const err = (t: string) => {
    const r = textToStages(t)
    return r.ok ? null : r.error
  }
  it('explains what is wrong', () => {
    expect(err('{ $match: {} }')).toMatch(/must be an array/)
    expect(err('[{ $match: {}, $sort: {} }]')).toMatch(/Stage 1: A stage can only have one operator/)
    expect(err('[{ $match: {} }, 5]')).toMatch(/Stage 2: Each stage must be an object/)
    expect(err('[{ $match: { a: "x }]')).toMatch(/Unterminated string/)
    expect(err('[{ $match: {} }')).toMatch(/not closed/)
    expect(err('[] extra')).toMatch(/Unexpected text/)
  })
  it('treats empty text as an empty pipeline', () => {
    expect(textToStages('  ')).toEqual({ ok: true, stages: [] })
  })
})

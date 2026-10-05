import { describe, it, expect } from 'vitest'
import { compareExtraction, summariseProvider } from './scanEvalCompare.js'

const L = (over = {}) => ({ description: 'a', quantity: 2, unit: 'เส้น', unit_price: 100, discount_pct: 0, ...over })

describe('compareExtraction', () => {
  it('scores a perfect read as 1', () => {
    const r = compareExtraction({ line_items: [L(), L({ description: 'b' })] }, { line_items: [L(), L({ description: 'b' })] })
    expect(r).toMatchObject({ lineCountMatches: true, quantityAcc: 1, unitPriceAcc: 1, unitAcc: 1, accuracy: 1 })
  })
  it('counts a wrong price and a wrong unit separately', () => {
    const r = compareExtraction({ line_items: [L(), L()] }, { line_items: [L({ unit_price: 90 }), L({ unit: 'ชิ้น' })] })
    expect(r.unitPriceAcc).toBe(0.5)
    expect(r.unitAcc).toBe(0.5)
    expect(r.quantityAcc).toBe(1)
  })
  it('penalises missing lines (compared over the expected lines)', () => {
    const r = compareExtraction({ line_items: [L(), L()] }, { line_items: [L()] })
    expect(r.lineCountMatches).toBe(false)
    expect(r.accuracy).toBe(0.5)
  })
  it('treats prices within half a satang as equal and handles an empty actual', () => {
    expect(compareExtraction({ line_items: [L({ unit_price: 100.004 })] }, { line_items: [L()] }).unitPriceAcc).toBe(1)
    expect(compareExtraction({ line_items: [L()] }, { line_items: [] }).accuracy).toBe(0)
  })
})

describe('summariseProvider', () => {
  it('averages accuracy, check pass rate and tokens', () => {
    const s = summariseProvider([
      { accuracy: 1, kind: 'ok', inputTokens: 100, outputTokens: 10 },
      { accuracy: 0.5, kind: 'check_failed', inputTokens: 300, outputTokens: 30 },
    ])
    expect(s).toEqual({ docs: 2, meanAccuracy: 0.75, checkPassRate: 0.5, inputTokens: 400, outputTokens: 40 })
  })
})

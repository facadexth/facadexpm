import { describe, it, expect } from 'vitest'
import { compareExtraction, summariseProvider, pickExampleFields, depositDeductionsMatch } from './scanEvalCompare.mjs'

const L = (over = {}) => ({ description: 'a', quantity: 2, unit: 'เส้น', unit_price: 100, discount_pct: 0, ...over })

describe('compareExtraction', () => {
  it('scores a perfect read as 1', () => {
    const r = compareExtraction({ line_items: [L(), L({ description: 'b' })] }, { line_items: [L(), L({ description: 'b' })] })
    expect(r).toMatchObject({ lineCountMatches: true, quantityAcc: 1, unitPriceAcc: 1, unitAcc: 1, accuracy: 1 })
  })
  it('does not score the unit when the document prints none', () => {
    const r = compareExtraction({ line_items: [L({ unit: '' })] }, { line_items: [L({ unit: 'ชิ้น' })] })
    expect(r.unitAcc).toBe(1)
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

describe('pickExampleFields', () => {
  it('drops status, printed_subtotal, printed_total, prices_include_vat and keeps only the saved keys', () => {
    const r = pickExampleFields({ status: 'success', printed_subtotal: 5, printed_total: 5.35, prices_include_vat: false, supplier_name_guess: 'ACME', document_date_guess: '2026-01-02', reference_no_guess: 'R1', line_items: [] })
    expect(Object.keys(r)).toEqual(['supplier_name_guess', 'document_date_guess', 'reference_no_guess', 'line_items'])
    expect(r.supplier_name_guess).toBe('ACME')
  })
  it('defaults missing header values to null and line_items to []', () => {
    expect(pickExampleFields({})).toEqual({ supplier_name_guess: null, document_date_guess: null, reference_no_guess: null, line_items: [] })
    expect(pickExampleFields(undefined).line_items).toEqual([])
  })
  it('reduces line items and defaults discount_pct to 0', () => {
    const r = pickExampleFields({ line_items: [{ description: 'b', quantity: 1, unit: 'x', unit_price: 5, extra: 'z' }, { description: 'c', quantity: 2, unit: 'y', unit_price: 6, discount_pct: 10 }] })
    expect(r.line_items).toEqual([
      { description: 'b', quantity: 1, unit: 'x', unit_price: 5, discount_pct: 0 },
      { description: 'c', quantity: 2, unit: 'y', unit_price: 6, discount_pct: 10 },
    ])
  })
})

describe('deposit_deductions comparison', () => {
  const exp = { line_items: [], deposit_deductions: [{ ref: 'AI6901007', amount: 41004 }] }
  it('matches with normalized ref and amount', () => {
    expect(depositDeductionsMatch(exp, { deposit_deductions: [{ ref: 'ai 6901007', amount: 41004 }] })).toBe(true)
    expect(compareExtraction(exp, { line_items: [], deposit_deductions: [{ ref: 'AI6901007', amount: 41004 }] }).accuracy).toBe(1)
  })
  it('fails on missing, wrong amount or extra', () => {
    expect(depositDeductionsMatch(exp, { deposit_deductions: [] })).toBe(false)
    expect(depositDeductionsMatch(exp, { deposit_deductions: [{ ref: 'AI6901007', amount: 41000 }] })).toBe(false)
    expect(depositDeductionsMatch(exp, { deposit_deductions: [{ ref: 'AI6901007', amount: 41004 }, { ref: 'X', amount: 1 }] })).toBe(false)
  })
  it('is ignored when the fixture has no deposit_deductions', () => {
    expect(depositDeductionsMatch({ line_items: [] }, { deposit_deductions: [{ ref: 'A', amount: 1 }] })).toBe(true)
  })
})

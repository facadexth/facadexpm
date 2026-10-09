import { describe, it, expect } from 'vitest'
import { buildComparison, nextAgreedSubNo } from './priceCompare.js'

// cost base per set: v 8000 + w 500 + z 500 + pm 1000 = 10000; price 10000 -> real 0.25 of v... use profitPct for "set"
const sItem = (id, o = {}) => ({ opening_id: id, opening_no: id.toUpperCase(), v: 8000, w: 500, z: 500, pm: 1000, price: 12000, quantity: 1, profitPct: 25, ...o })
const snap = items => ({ kind: 'sent', quotation_id: 'q1', revision: 1, sub_no: 1, items })
const qrow = (id, unit, qty = 1, extra = {}) => ({ id, item_type: 'item', unit_price: unit, quantity: qty, line_total: unit * qty, ...extra })
const lines = ids => ids.map(i => ({ opening_id: i, item_row_id: 'r-' + i }))
const noNaN = o => expect(JSON.stringify(o)).not.toMatch(/NaN|null.*undefined/)

describe('buildComparison', () => {
  it('returns null without a snapshot', () => {
    expect(buildComparison({ snapshot: null, quotation: {}, lines: [], quotationItems: [] })).toBeNull()
  })
  it('no discount, agreed = offered -> real profit follows the same base', () => {
    const c = buildComparison({ snapshot: snap([sItem('a')]), quotation: {}, lines: lines(['a']), quotationItems: [qrow('r-a', 12000)] })
    const r = c.rows[0]
    expect(r.offeredPrice).toBe(12000); expect(r.agreedUnit).toBe(12000); expect(r.discountShare).toBe(0)
    expect(r.agreedNet).toBe(12000); expect(r.diff).toBe(0); expect(r.diffPct).toBe(0)
    expect(r.costBase).toBe(10000)
    expect(r.realProfitPct).toBeCloseTo(25, 6); expect(r.profitDiffPts).toBeCloseTo(0, 6)
    expect(c.summary.reductionPct).toBe(0); expect(c.summary.realProfitPct).toBeCloseTo(25, 6)
  })
  it('amount discount 1,000 on lines 10,000 and 30,000 -> shares 250 / 750', () => {
    const c = buildComparison({
      snapshot: snap([sItem('a', { price: 10000 }), sItem('b', { price: 30000 })]),
      quotation: { discount_amount: 1000 }, lines: lines(['a', 'b']),
      quotationItems: [qrow('r-a', 10000), qrow('r-b', 30000)],
    })
    expect(c.rows[0].discountShare).toBeCloseTo(250, 6); expect(c.rows[1].discountShare).toBeCloseTo(750, 6)
    expect(c.rows[0].agreedNet).toBeCloseTo(9750, 6)
  })
  it('discount share is per unit (divided by quantity)', () => {
    const c = buildComparison({
      snapshot: snap([sItem('a', { price: 10000, quantity: 2 })]), quotation: { discount_amount: 1000 }, lines: lines(['a']),
      quotationItems: [qrow('r-a', 10000, 2)],
    })
    expect(c.rows[0].discountShare).toBeCloseTo(500, 6); expect(c.rows[0].agreedNet).toBeCloseTo(9500, 6)
  })
  it('5% discount', () => {
    const c = buildComparison({
      snapshot: snap([sItem('a', { price: 20000 })]), quotation: { discount_pct: 5 }, lines: lines(['a']), quotationItems: [qrow('r-a', 20000)],
    })
    expect(c.rows[0].discountShare).toBeCloseTo(1000, 6); expect(c.rows[0].agreedNet).toBeCloseTo(19000, 6)
    expect(c.summary.reductionPct).toBeCloseTo(5, 6)
  })
  it('VAT-inclusive 15,190 -> 14,196.26 net', () => {
    const c = buildComparison({
      snapshot: snap([sItem('a', { price: 14000 })]), quotation: { has_vat: true, price_includes_vat: true }, lines: lines(['a']),
      quotationItems: [qrow('r-a', 15190)],
    })
    expect(c.rows[0].agreedNet).toBeCloseTo(14196.26, 2)
  })
  it('VAT-inclusive with discount: discount comes off first, then / 1.07', () => {
    const c = buildComparison({
      snapshot: snap([sItem('a')]), quotation: { price_includes_vat: true, discount_amount: 1070 }, lines: lines(['a']), quotationItems: [qrow('r-a', 10700)],
    })
    expect(c.rows[0].agreedNet).toBeCloseTo(9000, 6)
  })
  it('a line removed in the quotation is listed and excluded from the summary', () => {
    const c = buildComparison({
      snapshot: snap([sItem('a'), sItem('b')]), quotation: {}, lines: lines(['a', 'b']), quotationItems: [qrow('r-a', 12000)],
    })
    expect(c.rows.map(r => r.openingId)).toEqual(['a'])
    expect(c.extras.removed.map(r => r.openingId)).toEqual(['b'])
    expect(c.summary.offeredTotal).toBe(12000)
  })
  it('a user-added row is listed in extras.added, not in the profit calculation, but takes part in the bill discount base', () => {
    const c = buildComparison({
      snapshot: snap([sItem('a', { price: 10000 })]), quotation: { discount_amount: 1000 }, lines: lines(['a']),
      quotationItems: [qrow('r-a', 10000), qrow('u1', 10000, 1, { description: 'ค่าขนย้าย' })],
    })
    expect(c.extras.added.map(r => r.id)).toEqual(['u1'])
    expect(c.rows).toHaveLength(1); expect(c.rows[0].discountShare).toBeCloseTo(500, 6)
    expect(c.summary.agreedTotal).toBeCloseTo(9500, 6)
  })
  it('description rows are never counted as added', () => {
    const c = buildComparison({
      snapshot: snap([sItem('a')]), quotation: {}, lines: lines(['a']),
      quotationItems: [qrow('r-a', 12000), { id: 'd1', item_type: 'item_description', unit_price: 0, quantity: 0, line_total: 0 }],
    })
    expect(c.extras.added).toEqual([])
  })
  it('V = 0 row has null profit and the summary has no NaN', () => {
    const c = buildComparison({
      snapshot: snap([sItem('a', { v: 0, w: 0, z: 0, pm: 0, profitPct: 0 }), sItem('b')]), quotation: {}, lines: lines(['a', 'b']),
      quotationItems: [qrow('r-a', 5000), qrow('r-b', 12000)],
    })
    expect(c.rows[0].realProfitPct).toBeNull(); expect(c.rows[0].profitDiffPts).toBeNull()
    expect(c.summary.realProfitPct).toBeCloseTo(25, 6)
    expect(JSON.stringify(c)).not.toContain('NaN')
  })
  it('all rows V=0 -> null summary profits, no NaN', () => {
    const c = buildComparison({ snapshot: snap([sItem('a', { v: 0, w: 0, z: 0, pm: 0 })]), quotation: {}, lines: lines(['a']), quotationItems: [qrow('r-a', 5000)] })
    expect(c.summary.setProfitPct).toBeNull(); expect(c.summary.realProfitPct).toBeNull()
    noNaN(c)
  })
  it('uses the snapshot cost base, not anything live', () => {
    const c = buildComparison({ snapshot: snap([sItem('a')]), quotation: {}, lines: lines(['a']), quotationItems: [qrow('r-a', 11000)] })
    expect(c.rows[0].realProfitPct).toBeCloseTo((11000 - 10000) / 8000 * 100, 6)
  })
})

describe('nextAgreedSubNo', () => {
  const s = [
    { kind: 'agreed', quotation_id: 'q1', revision: 2, sub_no: 1 }, { kind: 'agreed', quotation_id: 'q1', revision: 2, sub_no: 2 },
    { kind: 'sent', quotation_id: 'q1', revision: 2, sub_no: 5 }, { kind: 'agreed', quotation_id: 'q1', revision: 1, sub_no: 9 },
    { kind: 'agreed', quotation_id: 'q2', revision: 2, sub_no: 7 },
  ]
  it('counts only agreed snapshots of the same quotation and revision', () => {
    expect(nextAgreedSubNo(s, 'q1', 2)).toBe(3)
    expect(nextAgreedSubNo(s, 'q1', 3)).toBe(1)
    expect(nextAgreedSubNo(null, 'q1', 1)).toBe(1)
  })
})

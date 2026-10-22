import { describe, it, expect } from 'vitest'
import { isCountUnit, phaseWeight, deliveredBefore, doneQty, progressLineAmount, checkLine, legacyDeliveredQty } from './progressBilling.js'

describe('progressBilling', () => {
  it('plan cases', () => {
    expect(isCountUnit('ชุด')).toBe(true); expect(isCountUnit('ตร.ม.')).toBe(false); expect(isCountUnit(null)).toBe(false)
    expect(phaseWeight([{phase_id:'p',pct:20},{phase_id:'i',pct:60}], ['p','i'])).toBe(80)
    expect(progressLineAmount({ qty: 20, unitPrice: 3554.46, weightPct: 20 })).toBe(14217.84)
    // composite billed as % of quantity (real IN2610-003)
    expect(checkLine({ unit:'ตร.ม.', qty:20.8, unitPrice:3554.46, boqQty:26, boqUnitPrice:3900, priceMultiplier:0.91140, billedPct:100, phaseWeightPct:80, cardDoneQty:26 }))
      .toEqual({ level:'warn', reasons:['qty_is_pct_of_boq'] })
    // discount counts as match
    expect(checkLine({ unit:'ชุด', qty:1, unitPrice:21509.04, boqQty:1, boqUnitPrice:23600, priceMultiplier:0.91140, billedPct:80, phaseWeightPct:80, cardDoneQty:1 }).level).toBe('ok')
    // รื้อถอน billed 80% but weight 100
    expect(checkLine({ unit:'งาน', qty:1, unitPrice:16000, boqQty:1, boqUnitPrice:16000, priceMultiplier:1, billedPct:80, phaseWeightPct:100, cardDoneQty:1 }).reasons).toContain('weight_mismatch')
    // fractional set
    expect(checkLine({ unit:'ชุด', qty:0.8, unitPrice:41000, boqQty:1, boqUnitPrice:41000, priceMultiplier:1, billedPct:100, phaseWeightPct:80, cardDoneQty:1 }).level).toBe('block')
    // card without quantity
    expect(checkLine({ unit:'ชุด', qty:1, unitPrice:16405.2, boqQty:1, boqUnitPrice:18000, priceMultiplier:0.9114, billedPct:80, phaseWeightPct:80, cardDoneQty:null }).reasons).toEqual(['card_no_qty'])
    expect(deliveredBefore([{boq_item_id:'b',phase_id:'p',qty:8,invoice_status:'paid'},{boq_item_id:'b',phase_id:'p',qty:5,invoice_status:'void'}],'b','p')).toBe(8)
  })

  it('phaseWeight is 0 with no splits; doneQty sums cards and is null for status cards', () => {
    expect(phaseWeight([], ['p'])).toBe(0)
    expect(phaseWeight(null, ['p'])).toBe(0)
    const cards = [
      { boq_item_id:'b', phase_id:'p', done_qty:3, progress_mode:'quantity', planned_qty:5 },
      { boq_item_id:'b', phase_id:'p', done_qty:2, progress_mode:'quantity', planned_qty:5 },
      { boq_item_id:'b', phase_id:'q', done_qty:0, progress_mode:'status', planned_qty:null },
    ]
    expect(doneQty(cards, 'b', 'p')).toBe(5)
    expect(doneQty(cards, 'b', 'q')).toBeNull()
  })

  it('price mismatch and no weight', () => {
    const r = checkLine({ unit:'ตร.ม.', qty:5, unitPrice:100, boqQty:10, boqUnitPrice:120, priceMultiplier:1, billedPct:0, phaseWeightPct:0, cardDoneQty:5 })
    expect(r.level).toBe('warn')
    expect(r.reasons).toEqual(expect.arrayContaining(['price_mismatch', 'no_weight']))
    expect(checkLine({ unit:'ตร.ม.', qty:4, unitPrice:100, boqQty:10, boqUnitPrice:100, priceMultiplier:1, billedPct:50, phaseWeightPct:50, cardDoneQty:6 }).reasons).toEqual(['qty_not_card'])
  })
})

describe('legacyDeliveredQty', () => {
  const order = (...pcts) => pcts.map((pct, i) => ({ phase_id: 'p' + i, pct }))
  it('AD1 billed 80% with 40/40/10/10 -> ผลิต and ติดตั้ง fully delivered', () => {
    const po = order(40, 40, 10, 10)
    expect(legacyDeliveredQty({ billedFraction: 0.8, phaseOrder: po, phaseId: 'p0', boqQty: 1 })).toBe(1)
    expect(legacyDeliveredQty({ billedFraction: 0.8, phaseOrder: po, phaseId: 'p1', boqQty: 1 })).toBe(1)
    expect(legacyDeliveredQty({ billedFraction: 0.8, phaseOrder: po, phaseId: 'p2', boqQty: 1 })).toBe(0)
  })
  it('composite 26 with 20/60/10/10', () => {
    const po = order(20, 60, 10, 10)
    expect(legacyDeliveredQty({ billedFraction: 0.8, phaseOrder: po, phaseId: 'p0', boqQty: 26 })).toBe(26)
    expect(legacyDeliveredQty({ billedFraction: 0.8, phaseOrder: po, phaseId: 'p1', boqQty: 26 })).toBe(26)
    expect(legacyDeliveredQty({ billedFraction: 0.5, phaseOrder: po, phaseId: 'p0', boqQty: 26 })).toBe(26)
    expect(legacyDeliveredQty({ billedFraction: 0.5, phaseOrder: po, phaseId: 'p1', boqQty: 26 })).toBe(13)
    expect(legacyDeliveredQty({ billedFraction: 0, phaseOrder: po, phaseId: 'p0', boqQty: 26 })).toBe(0)
  })
})

import { describe, it, expect } from 'vitest'
import { buildReportRows, markColour, nextReportStatusOnEdit } from './deliveryReport.js'

const phases = [{ id: 'p1', name: 'ผลิต' }, { id: 'p2', name: 'ติดตั้ง' }]
const boqByQuotationItem = { qi1: { id: 'b1', unit: 'ตร.ม.', planned_qty: 26, code: '1' } }
const splitsByBoq = { b1: [{ phase_id: 'p2', pct: 80 }, { phase_id: 'p1', pct: 20 }] }
const cards = [
  { boq_item_id: 'b1', phase_id: 'p1', progress_mode: 'quantity', planned_qty: 26, done_qty: 26 },
  { boq_item_id: 'b1', phase_id: 'p2', progress_mode: 'quantity', planned_qty: 26, done_qty: 26 },
]
const base = { invoice: { id: 'inv' }, boqByQuotationItem, splitsByBoq, phases, cards, earlierItems: [], earlierItemPhases: [] }
const item = (id, total) => ({ id, quotation_item_id: 'qi1', unit_price: 500, line_total: total, description: 'A' })
const row = (rows, pid) => rows.find(r => r.phaseId === pid)

describe('buildReportRows', () => {
  it('progress invoice', () => {
    const { rows, totals } = buildReportRows({ ...base, invoiceItems: [item('it1', 2600)],
      itemPhases: [{ invoice_item_id: 'it1', boq_item_id: 'b1', phase_id: 'p1', qty: 26, weight_pct: 20, amount: 2600 }] })
    expect(rows.map(r => r.phaseName)).toEqual(['ผลิต', 'ติดตั้ง'])
    expect(row(rows, 'p1')).toMatchObject({ value: 2600, prev: 0, this: 2600, remaining: 0, check: 'ok' })
    expect(row(rows, 'p2')).toMatchObject({ value: 10400, this: 0, remaining: 10400, check: 'ok' })
    expect(totals.contract).toBe(13000)
    expect(totals.pctDone).toBe(20)
  })

  it('legacy invoice without phase rows', () => {
    const { rows } = buildReportRows({ ...base, invoiceItems: [item('it1', 13000)], itemPhases: [] })
    expect(row(rows, 'p1').this).toBe(2600)
    expect(row(rows, 'p2').this).toBe(10400)
  })

  it('legacy split only over phases with done cards', () => {
    const c = [cards[0], { ...cards[1], done_qty: 0 }]
    const { rows } = buildReportRows({ ...base, cards: c, invoiceItems: [item('it1', 2600)], itemPhases: [] })
    expect(row(rows, 'p1').this).toBe(2600)
    expect(row(rows, 'p2').this).toBe(0)
  })

  it('progress invoice line price (40% of the unit price) does not shrink the contract value', () => {
    // มศว proof: the invoice line carries price x weight; the DR must value the contract at the quotation price
    const boq = { qi1: { ...boqByQuotationItem.qi1, unit_price: 500 } }
    const { rows, totals } = buildReportRows({ ...base, boqByQuotationItem: boq,
      invoiceItems: [{ ...item('it1', 2600), unit_price: 100 }],
      itemPhases: [{ invoice_item_id: 'it1', boq_item_id: 'b1', phase_id: 'p1', qty: 26, weight_pct: 20, amount: 2600 }] })
    expect(totals.contract).toBe(13000)
    expect(row(rows, 'p1')).toMatchObject({ value: 2600, this: 2600, remaining: 0 })
    expect(row(rows, 'p2').value).toBe(10400)
  })

  it('legacy amount above the done phases spills into the next phases, not onto the done one', () => {
    // live IN2610-002: only ผลิต (p1, 2600) done, invoice bills 13000 → p1 full, rest to p2
    const c = [cards[0], { ...cards[1], done_qty: 0 }]
    const { rows } = buildReportRows({ ...base, cards: c, invoiceItems: [item('it1', 13000)], itemPhases: [] })
    expect(row(rows, 'p1')).toMatchObject({ this: 2600, remaining: 0 })
    expect(row(rows, 'p2')).toMatchObject({ this: 10400, remaining: 0 })
    expect(row(rows, 'p1').reasons).not.toContain('over_billed')
  })

  it('legacy split respects what earlier invoices billed per phase', () => {
    const { rows } = buildReportRows({ ...base,
      earlierItems: [item('e1', 2600)],
      earlierItemPhases: [{ invoice_item_id: 'e1', boq_item_id: 'b1', phase_id: 'p1', qty: 26, weight_pct: 20, amount: 2600 }],
      invoiceItems: [item('it2', 10400)], itemPhases: [] })
    expect(row(rows, 'p1')).toMatchObject({ prev: 2600, this: 0, remaining: 0 })
    expect(row(rows, 'p1').reasons).not.toContain('over_billed')
    expect(row(rows, 'p2')).toMatchObject({ this: 10400, remaining: 0 })
  })

  it('legacy split with no done cards spreads over all phases by weight', () => {
    const { rows } = buildReportRows({ ...base, cards: [], invoiceItems: [item('it1', 1000)], itemPhases: [] })
    expect(row(rows, 'p1').this).toBe(200)
    expect(row(rows, 'p2').this).toBe(800)
  })

  it('earlier invoice with phase rows and a plain line: prev not double counted', () => {
    const { rows, totals } = buildReportRows({ ...base,
      earlierItems: [item('e1', 2600), { id: 'e2', quotation_item_id: 'qz', unit_price: 500, line_total: 500, description: 'misc' }],
      earlierItemPhases: [{ invoice_item_id: 'e1', boq_item_id: 'b1', phase_id: 'p1', qty: 26, weight_pct: 20, amount: 2600 }],
      invoiceItems: [], itemPhases: [] })
    expect(row(rows, 'p1').prev).toBe(2600)
    expect(row(rows, 'p2').prev).toBe(0)
    expect(rows.find(r => r.phaseId === null).prev).toBe(500)
    expect(totals.prev).toBe(3100)
  })

  it('no-BOQ line', () => {
    const { rows } = buildReportRows({ ...base, boqByQuotationItem: {},
      invoiceItems: [{ id: 'x', quotation_item_id: 'qz', unit_price: 5000, line_total: 5000 }], itemPhases: [] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ phaseId: null, weightPct: null, value: 5000, this: 5000, remaining: 0 })
  })

  it('prev excludes current and later invoices', () => {
    const { rows } = buildReportRows({ ...base,
      earlierItems: [item('e1', 2600)],
      earlierItemPhases: [{ invoice_item_id: 'e1', boq_item_id: 'b1', phase_id: 'p1', qty: 26, weight_pct: 20, amount: 2600 }],
      invoiceItems: [item('it2', 10400)],
      itemPhases: [{ invoice_item_id: 'it2', boq_item_id: 'b1', phase_id: 'p2', qty: 26, weight_pct: 80, amount: 10400 }] })
    expect(row(rows, 'p1')).toMatchObject({ prev: 2600, this: 0, remaining: 0 })
    expect(row(rows, 'p2')).toMatchObject({ prev: 0, this: 10400, remaining: 0 })
  })

  it('over-billed', () => {
    const { rows } = buildReportRows({ ...base,
      earlierItems: [item('e1', 2600)],
      earlierItemPhases: [{ invoice_item_id: 'e1', boq_item_id: 'b1', phase_id: 'p1', qty: 26, weight_pct: 20, amount: 2600 }],
      invoiceItems: [item('it2', 100)],
      itemPhases: [{ invoice_item_id: 'it2', boq_item_id: 'b1', phase_id: 'p1', qty: 1, weight_pct: 20, amount: 100 }] })
    const r = row(rows, 'p1')
    expect(r.remaining).toBe(0)
    expect(r.reasons).toContain('over_billed')
    expect(r.check).not.toBe('ok')
  })

  it('satang', () => {
    const ph = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }]
    const { rows, totals } = buildReportRows({ ...base, phases: ph, cards: [],
      boqByQuotationItem: { qi1: { id: 'b1', unit: 'งาน', planned_qty: 1, code: '1' } },
      splitsByBoq: { b1: [{ phase_id: 'a', pct: 33.33 }, { phase_id: 'b', pct: 33.33 }, { phase_id: 'c', pct: 33.34 }] },
      invoiceItems: [{ id: 'i', quotation_item_id: 'qi1', unit_price: 1000, line_total: 0 }], itemPhases: [] })
    expect(rows.map(r => r.value)).toEqual([333.3, 333.3, 333.4])
    expect(totals.contract).toBe(1000)
  })

  it('no-BOQ rows come last, BOQ by code', () => {
    const { rows } = buildReportRows({ ...base,
      boqByQuotationItem: { qi1: boqByQuotationItem.qi1, qi0: { id: 'b0', unit: 'ชุด', planned_qty: 1, code: '10' } },
      splitsByBoq: { ...splitsByBoq, b0: [{ phase_id: 'p1', pct: 100 }] },
      invoiceItems: [{ id: 'x', quotation_item_id: 'qz', unit_price: 1, line_total: 1 }], itemPhases: [] })
    expect(rows.map(r => r.boqCode)).toEqual(['1', '1', '10', null])
  })
})

describe('markColour', () => {
  const sets = { prevTaskIds: new Set(['a', 'b']), thisTaskIds: new Set(['b', 'c']) }
  it('this wins over prev', () => expect(markColour('b', sets)).toBe('#f97316'))
  it('prev', () => expect(markColour('a', sets)).toBe('#16a34a'))
  it('remaining', () => expect(markColour('z', sets)).toBe('#9ca3af'))
})

describe('nextReportStatusOnEdit', () => {
  it('signed → reissue', () => expect(nextReportStatusOnEdit({ status: 'signed' })).toBe('reissue'))
  it('issued → edit-in-place', () => expect(nextReportStatusOnEdit({ status: 'issued' })).toBe('edit-in-place'))
})

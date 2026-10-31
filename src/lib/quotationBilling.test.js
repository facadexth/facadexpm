import { describe, it, expect } from 'vitest'
import { summarizeQuotationBilling } from './quotationBilling.js'

const Q1 = { id: 'q1', quotation_number: 'QT-053', date: '2026-09-01', subtotal: 260700, total: 278949 }
const Q2 = { id: 'q2', quotation_number: 'QT-071', date: '2026-10-05', subtotal: 154350, total: 165154.5 }

describe('summarizeQuotationBilling', () => {
  it('a site with only a deposit has billed nothing', () => {
    const r = summarizeQuotationBilling([Q1], [{ quotation_id: 'q1', subtotal: '78210', status: 'paid', is_deposit: true }])
    expect(r.rows[0].billedTotal).toBe(0)
    expect(r.rows[0].pct).toBe(0)
    expect(r.sum.pct).toBe(0)
  })
  it('void invoices do not count', () => {
    const r = summarizeQuotationBilling([Q1], [{ quotation_id: 'q1', subtotal: '260700', status: 'void', is_deposit: false }])
    expect(r.rows[0].pct).toBe(0)
  })
  it('a partial billing is a share of the quotation, shown incl. VAT', () => {
    const r = summarizeQuotationBilling([Q1], [{ quotation_id: 'q1', subtotal: '150000', status: 'paid', is_deposit: false }])
    expect(r.rows[0].pct).toBe(57.5)
    expect(r.rows[0].billedTotal).toBe(160500)
    expect(r.rows[0].remainingTotal).toBe(118449)
  })
  it('fully billed reads exactly 100% even when a later invoice carried less VAT', () => {
    const r = summarizeQuotationBilling([Q1], [{ quotation_id: 'q1', subtotal: '260700', status: 'issued', is_deposit: false }])
    expect(r.rows[0].pct).toBe(100)
    expect(r.rows[0].remainingTotal).toBe(0)
  })
  it('extra-work quotation is listed separately and the sum covers all of them, oldest first', () => {
    const r = summarizeQuotationBilling([Q2, Q1], [
      { quotation_id: 'q1', subtotal: '260700', status: 'paid', is_deposit: false },
      { quotation_id: 'q2', subtotal: '77175', status: 'issued', is_deposit: false },
    ])
    expect(r.rows.map((x) => x.id)).toEqual(['q1', 'q2'])
    expect(r.rows[1].pct).toBe(50)
    expect(r.sum.total).toBe(444103.5)
    expect(r.sum.billedTotal).toBe(278949 + 82577.25)
    expect(r.sum.remainingTotal).toBe(82577.25)
  })
  it('handles no quotations / no invoices', () => {
    expect(summarizeQuotationBilling([], []).rows).toEqual([])
    expect(summarizeQuotationBilling(null, null).sum.total).toBe(0)
  })
})

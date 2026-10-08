import { describe, it, expect } from 'vitest'
import { checkLine, CHECK_TEXT } from './supplierTaxInvoice.js'

describe('checkLine', () => {
  const base = CHECK_TEXT.po_no_receipt_movements
  it('appends the receipt no', () => {
    expect(checkLine({ code: 'po_no_receipt_movements', receipt_no: 'PO-1-R2', po_id: 'p' }, new Map([['p', 'PO-1']]))).toBe(`${base} (PO-1-R2)`)
  })
  it('falls back to the PO number, then to nothing', () => {
    expect(checkLine({ code: 'po_no_receipt_movements', po_id: 'p' }, new Map([['p', 'PO-1']]))).toBe(`${base} (PO-1)`)
    expect(checkLine({ code: 'po_no_receipt_movements' }, new Map())).toBe(base)
  })
})

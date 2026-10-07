import { describe, it, expect } from 'vitest'
import { poTaxInvoiceBadge, buildPoPayloadFlag, poEditLockedText, poTaxInvoiceErrorText } from './poTaxInvoiceStatus.js'

describe('poTaxInvoiceBadge', () => {
  const links = new Map([['p1', { invoice_id: 'i1', invoice_no: 'INV-1', status: 'posted' }], ['p3', { invoice_id: 'i3', invoice_no: 'INV-3', status: 'draft' }]])
  it('linked PO shows the invoice number (draft says so)', () => {
    expect(poTaxInvoiceBadge({ id: 'p1', status: 'received' }, links)).toEqual({ kind: 'linked', text: 'ใบกำกับ INV-1' })
    expect(poTaxInvoiceBadge({ id: 'p3', status: 'received' }, links)).toEqual({ kind: 'linked', text: 'ใบกำกับ INV-3 (ร่าง)' })
  })
  it('received flagged PO without an invoice is awaiting stock', () => {
    expect(poTaxInvoiceBadge({ id: 'p2', status: 'received', stock_from_invoice: true }, links)).toEqual({ kind: 'awaiting', text: 'รอใบกำกับ (สต็อกยังไม่เข้า)' })
  })
  it('no links map (feature not ready) -> no badge', () => {
    expect(poTaxInvoiceBadge({ id: 'p1', status: 'received', stock_from_invoice: true }, null)).toEqual({ kind: null, text: '' })
  })
  it('plain PO -> no badge', () => {
    expect(poTaxInvoiceBadge({ id: 'p9', status: 'received' }, links)).toEqual({ kind: null, text: '' })
  })
})

describe('buildPoPayloadFlag (deploy-order safe)', () => {
  it('new PO: send the flag only when ticked', () => {
    expect(buildPoPayloadFlag({ stock_from_invoice: false }, null)).toEqual({})
    expect(buildPoPayloadFlag({ stock_from_invoice: true }, null)).toEqual({ stock_from_invoice: true })
  })
  it('edit: send it when the column exists on the row', () => {
    expect(buildPoPayloadFlag({ stock_from_invoice: false }, { stock_from_invoice: true })).toEqual({ stock_from_invoice: false })
    expect(buildPoPayloadFlag({ stock_from_invoice: false }, { id: 'x' })).toEqual({})
  })
})

describe('poEditLockedText', () => {
  const links = new Map([['p1', { invoice_id: 'i1', invoice_no: 'INV-1', status: 'draft' }]])
  it('linked PO is locked with the invoice number; others and not-ready are not', () => {
    expect(poEditLockedText({ id: 'p1' }, links)).toBe('ใบสั่งซื้อนี้ผูกกับใบกำกับภาษี INV-1 แก้ไขไม่ได้')
    expect(poEditLockedText({ id: 'p2' }, links)).toBe('')
    expect(poEditLockedText({ id: 'p1' }, null)).toBe('')
  })
})

describe('poTaxInvoiceErrorText', () => {
  it('maps tax invoice trigger errors and deadlocks to Thai, leaves others alone', () => {
    expect(poTaxInvoiceErrorText({ message: 'po_tax_invoiced — x' })).toMatch(/ใบกำกับภาษี/)
    expect(poTaxInvoiceErrorText({ code: '40P01', message: 'deadlock detected' })).toMatch(/ลองใหม่/)
    expect(poTaxInvoiceErrorText({ message: 'po_stock_flag_locked' })).toMatch(/สต็อกเข้าจากใบกำกับ/)
    expect(poTaxInvoiceErrorText({ message: 'something else' })).toBe(null)
    expect(poTaxInvoiceErrorText(null)).toBe(null)
  })
})

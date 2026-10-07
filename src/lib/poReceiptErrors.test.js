// src/lib/poReceiptErrors.test.js
import { describe, it, expect } from 'vitest'
import { mapPoReceiptRpcError, buildPoMoneyIndex, poMoneyLockText, poLedgerSummary, PO_RECEIPT_LOCKED_TEXT, PO_HAS_DEPOSIT_TEXT, depositSelectableForPo } from './poReceiptErrors.js'

describe('mapPoReceiptRpcError', () => {
  it('maps every new code to Thai and never shows the raw code', () => {
    for (const code of ['line_already_received', 'po_not_receivable', 'received_date_in_future', 'bad_received_date', 'deposit_exceeds_receipt',
      'deposit_vat_exceeds_receipt', 'bad_stock_plan', 'stock_cost_mismatch', 'po_has_deposit', 'po_has_receipts', 'deposit_invoice_no_taken',
      'deposit_invoice_no_required', 'bill_not_pending', 'bad_split_amount', 'expense_is_receipt_bill', 'expense_is_split_part', 'po_status_rpc_only',
      'totals_mismatch', 'deposit_exceeds_remaining', 'po_tax_invoiced', 'insufficient_privilege',
      'deposit_other_po', 'deposit_linked_to_po', 'bill_changed', 'bad_lines', 'deposit_in_use', 'cross_tenant_reference', 'deposit_expense_is_po_generated',
      'po_not_found', 'deposit_not_found', 'deposit_exceeds_po', 'deposit_wrong_supplier', 'not_a_po_bill', 'bad_application', 'not_ordered']) {
      const t = mapPoReceiptRpcError({ message: code })
      expect(t, code).not.toContain(code)
      expect(t.length, code).toBeGreaterThan(5)
    }
  })
  it('longest code wins (po_has_deposit_applications vs po_has_deposit)', () => {
    expect(mapPoReceiptRpcError({ message: 'po_has_deposit_applications' })).not.toBe(PO_HAS_DEPOSIT_TEXT)
    expect(mapPoReceiptRpcError({ message: 'po_has_deposit' })).toBe(PO_HAS_DEPOSIT_TEXT)
  })
  it('deadlock -> retry text; unknown -> raw', () => {
    expect(mapPoReceiptRpcError({ code: '40P01', message: 'deadlock detected' })).toContain('ลองใหม่')
    expect(mapPoReceiptRpcError({ message: 'boom' })).toBe('boom')
  })
})

describe('buildPoMoneyIndex / poMoneyLockText', () => {
  const idx = buildPoMoneyIndex({
    receiptItems: [{ po_item_id: 'i1', po_receipts: { po_id: 'P1' } }],
    deposits: [{ id: 'd1', po_id: 'P2' }],
  })
  it('indexes receipts and deposits by PO', () => {
    expect([...idx.get('P1').receivedItemIds]).toEqual(['i1'])
    expect(idx.get('P2').depositId).toBe('d1')
    expect(idx.get('P3')).toBeUndefined()
  })
  it('lock texts', () => {
    expect(poMoneyLockText({ id: 'P1' }, idx)).toBe(PO_RECEIPT_LOCKED_TEXT)
    expect(poMoneyLockText({ id: 'P2' }, idx)).toBe(PO_HAS_DEPOSIT_TEXT)
    expect(poMoneyLockText({ id: 'P3' }, idx)).toBe('')
    expect(poMoneyLockText({ id: 'P1' }, null)).toBe('')
  })
})

describe('poLedgerSummary', () => {
  const po = { id: 'P', status: 'partially_received', received_date: '2026-10-05', purchase_order_items: [{ id: 'a', line_total: 60000 }, { id: 'b', line_total: 40000 }] }
  it('lines, receipts and deposit remaining', () => {
    const s = poLedgerSummary(po, {
      receipts: [{ id: 'r1', seq: 1, received_date: '2026-10-05', goods_subtotal: 60000, goods_vat: 4200, po_receipt_items: [{ po_item_id: 'a' }] }],
      deposit: { id: 'd', deposit_invoice_no: 'DEP', pct_of_po: 30, expenses: { amount_no_vat: 30000, vat: 2100, status: 'paid' }, po_deposit_applications: [{ amount_no_vat: 18000, vat: 1260 }] },
      applications: [], bills: [],
    })
    expect(s.lines.map(l => [l.id, l.received, l.receivedDate, l.receiptSeq])).toEqual([['a', true, '2026-10-05', 1], ['b', false, null, null]])
    expect(s.deposit).toMatchObject({ gross: 32100, usedGross: 19260, remainingGross: 12840, pct: 30 })
    expect(s.outstandingCount).toBe(1)
    expect(s.legacy).toBe(false)
  })
  it('poLedgerSummary legacy: received the old way, no receipt rows', () => {
    const s = poLedgerSummary({ ...po, status: 'received' }, { receipts: [], deposit: null, applications: [], bills: [] })
    expect(s.legacy).toBe(true)
    expect(s.lines.every(l => l.received && l.receivedDate === '2026-10-05')).toBe(true)
    expect(s.outstandingCount).toBe(0)
  })
  it('ไทย-เยอรมัน after the data fix: remaining 0', () => {
    const s = poLedgerSummary({ ...po, status: 'received' }, { receipts: [], applications: [], bills: [],
      deposit: { id: 'd', deposit_invoice_no: '2602543', pct_of_po: 50, expenses: { amount_no_vat: 103365, vat: 7235.55, status: 'paid' }, po_deposit_applications: [{ amount_no_vat: 103365, vat: 7235.55 }] } })
    expect(s.deposit).toMatchObject({ gross: 110600.55, usedGross: 110600.55, remainingGross: 0 })
  })
  it('null ledger (loading / migration missing) does not crash', () => {
    expect(poLedgerSummary(po, null).deposit).toBeNull()
  })
})

describe('depositSelectableForPo', () => {
  it('hides deposits of another PO only', () => {
    expect(depositSelectableForPo({ po_id: null }, 'P1')).toBe(true)
    expect(depositSelectableForPo({}, 'P1')).toBe(true)
    expect(depositSelectableForPo({ po_id: 'P1' }, 'P1')).toBe(true)
    expect(depositSelectableForPo({ po_id: 'P2' }, 'P1')).toBe(false)
  })
})

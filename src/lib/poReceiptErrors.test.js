// src/lib/poReceiptErrors.test.js
import { describe, it, expect } from 'vitest'
import { mapPoReceiptRpcError, buildPoMoneyIndex, poMoneyLockText, poLedgerSummary, PO_RECEIPT_LOCKED_TEXT, PO_HAS_DEPOSIT_TEXT, depositSelectableForPo, isMissingColumnError, PO_RECEIPT_ERROR_TEXT, receiveRoute, receiveDialogDeposits, canOfferCreateDeposit, DB_NOT_UPDATED_TEXT, RECEIVE_NOT_READY_TEXT, poHasMultipleBills, isMissingEmbedError } from './poReceiptErrors.js'
import { RECEIVE_DELIVERY_DISCOUNT_TEXT } from './deliveryTaxInvoiceText.js'
import { readFileSync } from 'node:fs'

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
    receiptItems: [{ po_item_id: 'i1', receipt_id: 'r1', po_receipts: { po_id: 'P1' } }, { po_item_id: 'i2', receipt_id: 'r2', po_receipts: { po_id: 'P1' } }],
    deposits: [{ id: 'd1', po_id: 'P2' }],
  })
  it('indexes receipts and deposits by PO', () => {
    expect([...idx.get('P1').receivedItemIds]).toEqual(['i1', 'i2'])
    expect(idx.get('P1').receiptIds.size).toBe(2)
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

describe('isMissingColumnError', () => {
  it('only the undefined-column case', () => {
    expect(isMissingColumnError({ code: '42703', message: 'x' }, 'po_id')).toBe(true)
    expect(isMissingColumnError({ message: 'column supplier_deposits.po_id does not exist' }, 'po_id')).toBe(true)
    expect(isMissingColumnError({ message: 'TypeError: Failed to fetch' }, 'po_id')).toBe(false)
    expect(isMissingColumnError({ code: '500', message: 'Internal Server Error' }, 'po_id')).toBe(false)
    expect(isMissingColumnError(undefined, 'po_id')).toBe(false)
  })
})

describe('error text reads details and hint', () => {
  it('finds a code in details/hint, message first', () => {
    expect(mapPoReceiptRpcError({ message: 'x', details: 'bill_changed' })).toBe(PO_RECEIPT_ERROR_TEXT.bill_changed)
    expect(mapPoReceiptRpcError({ message: 'x', hint: 'bad_lines' })).toBe(PO_RECEIPT_ERROR_TEXT.bad_lines)
    expect(mapPoReceiptRpcError({ message: 'bad_lines', details: 'bill_changed' })).toBe(PO_RECEIPT_ERROR_TEXT.bad_lines)
  })
})

describe('every RAISE EXCEPTION literal in the migrations has Thai text', () => {
  // none intentionally unmapped; add here with a comment if one ever must be
  const ALLOW = []
  for (const f of ['2026-10-09-01-po-receipts.sql', '2026-10-09-02-po-receipt-rpcs.sql']) {
    it(f, () => {
      const sql = readFileSync(new URL('../../supabase/migrations/' + f, import.meta.url), 'utf8')
      const codes = [...new Set([...sql.matchAll(/RAISE EXCEPTION '([a-z_0-9]+)'/g)].map(m => m[1]))].filter(c => !ALLOW.includes(c))
      expect(codes.length).toBeGreaterThan(3)
      for (const c of codes) expect(PO_RECEIPT_ERROR_TEXT[c], c).toBeTruthy()
    })
  }
})

describe('buildPoMoneyIndex schemaReady (Task 9 routing)', () => {
  it('defaults to ready; a soft-failed (pre-migration) index says not ready', () => {
    expect(buildPoMoneyIndex({ receiptItems: [], deposits: [] }).schemaReady).toBe(true)
    expect(buildPoMoneyIndex({ receiptItems: [], deposits: [], schemaReady: false }).schemaReady).toBe(false)
  })
})

describe('receiveRoute (Task 9)', () => {
  const item = (o = {}) => ({ id: 'i1', line_total: 100, ...o })
  const ready = Object.assign(new Map(), { schemaReady: true })
  const pre = Object.assign(new Map(), { schemaReady: false })
  const po = (status, items = [item()]) => ({ id: 'P1', status, purchase_order_items: items })
  it('new dialog for ordered / partially received when the schema is ready', () => {
    expect(receiveRoute(po('ordered'), ready)).toEqual({ kind: 'new' })
    expect(receiveRoute(po('partially_received'), ready)).toEqual({ kind: 'new' })
  })
  it('old receive for an ordered PO only when the schema is known to be missing (pre-migration soft fail)', () => {
    expect(receiveRoute(po('ordered'), pre)).toEqual({ kind: 'old' })
  })
  it('index null (loading / real failure): disabled with the loading text for every receivable status', () => {
    for (const s of ['ordered', 'partially_received']) {
      const r = receiveRoute(po(s), null)
      expect(r.kind, s).toBe('disabled')
      expect(r.reason).toBe(RECEIVE_NOT_READY_TEXT)
    }
  })
  it('partially received without the schema: disabled with a reason', () => {
    expect(receiveRoute(po('partially_received'), pre)).toEqual({ kind: 'disabled', reason: RECEIVE_NOT_READY_TEXT })
  })
  it('a discount line (line_total < 0) always uses the old receive on an ordered PO', () => {
    expect(receiveRoute(po('ordered', [item(), item({ id: 'i2', line_total: -10 })]), ready)).toEqual({ kind: 'old' })
    expect(receiveRoute(po('partially_received', [item(), item({ id: 'i2', line_total: -10 })]), ready).kind).toBe('disabled')
  })
  it('other statuses: nothing', () => {
    for (const s of ['draft', 'received', 'cancelled']) expect(receiveRoute(po(s), ready)).toBeNull()
  })
})

describe('canOfferCreateDeposit (Task 9 fix R-C)', () => {
  const ready = Object.assign(new Map(), { schemaReady: true })
  const pre = Object.assign(new Map(), { schemaReady: false })
  const po = (o = {}) => ({ id: 'P1', status: 'ordered', purchase_order_items: [{ id: 'i1', line_total: 100 }], ...o })
  it('only on the live schema, ordered POs without a discount line', () => {
    expect(canOfferCreateDeposit(po(), ready)).toBe(true)
    expect(canOfferCreateDeposit(po(), null)).toBe(false)
    expect(canOfferCreateDeposit(po(), pre)).toBe(false)
    expect(canOfferCreateDeposit(po({ status: 'partially_received' }), ready)).toBe(false)
    expect(canOfferCreateDeposit(po({ purchase_order_items: [{ id: 'i1', line_total: 100 }, { id: 'i2', line_total: -5 }] }), ready)).toBe(false)
  })
})

describe('mapPoReceiptRpcError: RPC not deployed (Task 9 fix M1)', () => {
  it('PGRST202 / could not find the function -> Thai', () => {
    expect(mapPoReceiptRpcError({ code: 'PGRST202', message: 'x' })).toBe(DB_NOT_UPDATED_TEXT)
    expect(mapPoReceiptRpcError({ message: 'Could not find the function public.receive_po_lines(p_po_id, ...) in the schema cache' })).toBe(DB_NOT_UPDATED_TEXT)
  })
})

describe('receiveDialogDeposits (Task 9, R6)', () => {
  const dep = (id, o = {}) => ({ id, deposit_invoice_no: id.toUpperCase(), expense: { supplier_id: 'S', amount: 107, amount_no_vat: 100, vat: 7 }, applications: [], ...o })
  it('keeps legacy (po_id null) and own deposits, drops other POs\' deposits and used-up ones, own first', () => {
    const rows = [dep('a', { po_id: null }), dep('b', { po_id: 'P2' }), dep('c', { po_id: 'P1' }), dep('d', { applications: [{ amount_no_vat: 100, vat: 7 }] })]
    const out = receiveDialogDeposits(rows, 'P1', 'c')
    expect(out.map(d => d.id)).toEqual(['c', 'a'])
    expect(out[1].supplier_id).toBe('S')
    expect(out[0].remaining).toEqual({ net: 100, vat: 7 })
  })
  it('null rows -> empty list', () => {
    expect(receiveDialogDeposits(null, 'P1', null)).toEqual([])
  })
})

describe('poHasMultipleBills (swap-invoice lock, Task 10)', () => {
  const idx = buildPoMoneyIndex({
    receiptItems: [{ po_item_id: 'i1', receipt_id: 'r1', po_receipts: { po_id: 'A' } }, { po_item_id: 'i2', receipt_id: 'r2', po_receipts: { po_id: 'B' } }, { po_item_id: 'i3', receipt_id: 'r3', po_receipts: { po_id: 'B' } }],
    deposits: [],
    bills: [{ id: 'e1', po_id: 'A' }, { id: 'e2', po_id: 'C' }, { id: 'e3', po_id: 'C' }, { id: 'e4', po_id: null }],
  })
  it('single bill: false; several receipts: true; a split (2 expense rows, 1 receipt): true', () => {
    expect(poHasMultipleBills({ id: 'A' }, idx)).toBe(false)
    expect(poHasMultipleBills({ id: 'B' }, idx)).toBe(true)
    expect(poHasMultipleBills({ id: 'C' }, idx)).toBe(true)
    expect(poHasMultipleBills({ id: 'Z' }, idx)).toBe(false)
    expect(poHasMultipleBills({ id: 'A' }, null)).toBe(false)
  })
})

describe('receiveRoute for delivery-mode POs (never the old whole-PO receive)', () => {
  const item = (o = {}) => ({ id: 'i1', line_total: 100, ...o })
  const dpo = (status, items = [item()]) => ({ id: 'P', status, tax_invoice_mode: 'delivery', purchase_order_items: items })
  const ready = buildPoMoneyIndex({ receiptItems: [], deposits: [] })
  const pre = buildPoMoneyIndex({ receiptItems: [], deposits: [], schemaReady: false })
  it('new dialog when the schema is ready', () => {
    expect(receiveRoute(dpo('ordered'), ready)).toEqual({ kind: 'new' })
    expect(receiveRoute(dpo('partially_received'), ready)).toEqual({ kind: 'new' })
  })
  it('disabled (not old) before the schema and with a discount line', () => {
    expect(receiveRoute(dpo('ordered'), pre)).toEqual({ kind: 'disabled', reason: RECEIVE_NOT_READY_TEXT })
    expect(receiveRoute(dpo('ordered', [item(), item({ id: 'i2', line_total: -5 })]), ready)).toEqual({ kind: 'disabled', reason: RECEIVE_DELIVERY_DISCOUNT_TEXT })
  })
})
describe('isMissingEmbedError', () => {
  it('PGRST200 naming the table only', () => {
    expect(isMissingEmbedError({ code: 'PGRST200', message: "Could not find a relationship between 'supplier_tax_invoices' and 'supplier_tax_invoice_receipts' in the schema cache" }, 'supplier_tax_invoice_receipts')).toBe(true)
    expect(isMissingEmbedError({ code: 'PGRST200', message: "... 'suppliers' ..." }, 'supplier_tax_invoice_receipts')).toBe(false)
    expect(isMissingEmbedError({ code: '42501', message: 'supplier_tax_invoice_receipts' }, 'supplier_tax_invoice_receipts')).toBe(false)
    expect(isMissingEmbedError(null, 'x')).toBe(false)
  })
})

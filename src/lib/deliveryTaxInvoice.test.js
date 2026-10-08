import { describe, it, expect } from 'vitest'
import {
  receiptLabel, evaluateDeliveryMatch, buildActiveReceiptLinkMap, receiptEligibility, receiptPickerRows,
  receiptsAwaitingInvoice, receiptTaxInvoiceStatus, defaultTaxInvoiceMode, poModePayload, supplierModePayload,
  poModeLockedText, deliveryPoBadge, formForReceipt, invoiceMatchBase, linkKindOf,
  poModeForSupplier, poDeliveryDiscountWarning, splitDeliveryPoIds,
} from './deliveryTaxInvoice.js'
import { PO_MODE_LOCKED_TEXT, DELIVERY_CHECK_TEXT, DELIVERY_RPC_TEXT, RECEIVE_DELIVERY_DISCOUNT_TEXT, PO_DELIVERY_DISCOUNT_SAVE_TEXT } from './deliveryTaxInvoiceText.js'

const po = (o = {}) => ({ id: 'P1', po_number: 'PO-1', supplier_id: 'S', site_id: 'SITE', tax_invoice_mode: 'delivery', stock_from_invoice: false, has_vat: true, price_includes_vat: false, ...o })
const rc = (id, o = {}, p = {}) => ({ id, po_id: 'P1', seq: 1, received_date: '2026-10-05', goods_subtotal: 600, goods_vat: 42, expense_id: 'e' + id, purchase_orders: po(p), po_receipt_items: [], ...o })
const links = entries => new Map(entries)

describe('texts', () => {
  it('every code has Thai text', () => {
    for (const t of [...Object.values(DELIVERY_CHECK_TEXT), ...Object.values(DELIVERY_RPC_TEXT), PO_MODE_LOCKED_TEXT, RECEIVE_DELIVERY_DISCOUNT_TEXT]) {
      expect(t).toMatch(/[฀-๿]/)
    }
    for (const c of ['po_mode_locked', 'po_delivery_needs_receipt', 'receipt_not_eligible', 'receipt_linked_elsewhere', 'invoice_mixed_links', 'po_is_delivery_mode']) expect(DELIVERY_RPC_TEXT[c], c).toBeTruthy()
    for (const c of ['receipt_not_found', 'receipt_wrong_supplier', 'receipt_po_not_delivery', 'receipt_linked_elsewhere', 'receipt_already_reversed', 'receipt_stock_from_invoice', 'receipt_no_stock_movements', 'receipt_outside_month', 'receipt_has_deposit', 'receipt_no_expense', 'match_vat_inclusive', 'vat_rate_mismatch', 'invoice_mixed_links', 'po_is_delivery_mode']) expect(DELIVERY_CHECK_TEXT[c], c).toBeTruthy()
    // expense_missing (also reported by _sti_check_delivery) keeps its existing CHECK_TEXT entry: it must NOT be
    // redefined here, because Task 5 spreads DELIVERY_CHECK_TEXT last into CHECK_TEXT (it would override the PO text)
    expect('expense_missing' in DELIVERY_CHECK_TEXT).toBe(false)
  })
})

describe('receiptLabel', () => {
  it('PO number + -R + seq', () => {
    expect(receiptLabel('PO2610-038', 2)).toBe('PO2610-038-R2')
    expect(receiptLabel(null, 1)).toBe('?-R1')
  })
})

describe('evaluateDeliveryMatch (mirror of _sti_check_delivery)', () => {
  it('excl basis within tolerance', () => {
    const m = evaluateDeliveryMatch({ netBeforeVat: '600', grandTotal: 642, receipts: [rc('a')], lineAmounts: [600] })
    expect(m).toMatchObject({ invalid: false, sum: 600, sumIncl: 642, diffExcl: 0, diffIncl: 0, basis: 'excl', matchOk: true, diff: 0, tolerance: 5, linesOk: true })
  })
  it('VAT-inclusive basis when the net is off but the total matches (SQL test B7 numbers)', () => {
    const m = evaluateDeliveryMatch({ netBeforeVat: 1390, grandTotal: 1498,
      receipts: [rc('a', { goods_subtotal: 400, goods_vat: 28 }), rc('b', { goods_subtotal: 1000, goods_vat: 70 })], lineAmounts: [390, 1000] })
    expect(m).toMatchObject({ sum: 1400, sumIncl: 1498, diffExcl: -10, diffIncl: 0, basis: 'incl', matchOk: true, diff: 0, tolerance: 5, linesOk: true })
  })
  it('neither basis: no match, diff = excl diff (SQL test B14 numbers)', () => {
    const m = evaluateDeliveryMatch({ netBeforeVat: 200, grandTotal: 214, receipts: [rc('a', { goods_subtotal: 300, goods_vat: 21 })], lineAmounts: [200] })
    expect(m).toMatchObject({ basis: 'none', matchOk: false, diff: -100, diffExcl: -100, diffIncl: -107 })
  })
  it('tolerance = min(1% of base, 5): edge passes, one satang beyond fails', () => {
    const r = [rc('a', { goods_subtotal: 100, goods_vat: 7 })]
    expect(evaluateDeliveryMatch({ netBeforeVat: 101, grandTotal: 108, receipts: r, lineAmounts: [101] }).basis).toBe('excl')
    expect(evaluateDeliveryMatch({ netBeforeVat: 101.02, grandTotal: 999, receipts: r, lineAmounts: [101.02] }).basis).toBe('none')
  })
  it('blank / non-finite -> invalid, never a match', () => {
    expect(evaluateDeliveryMatch({ netBeforeVat: '', grandTotal: 0, receipts: [rc('a')], lineAmounts: [] }).invalid).toBe(true)
    const bad = evaluateDeliveryMatch({ netBeforeVat: 600, grandTotal: 642, receipts: [rc('a', { goods_subtotal: 'NaN' })], lineAmounts: [] })
    expect(bad.invalid).toBe(true); expect(bad.matchOk).toBe(false)
  })
})

describe('buildActiveReceiptLinkMap', () => {
  it('active rows only; missing embed -> empty texts; null -> empty map', () => {
    const m = buildActiveReceiptLinkMap([
      { receipt_id: 'r1', invoice_id: 'i1', active: true, supplier_tax_invoices: { invoice_no: 'INV-1', status: 'draft' } },
      { receipt_id: 'r2', invoice_id: 'i0', active: false, supplier_tax_invoices: { invoice_no: 'OLD', status: 'void' } },
      { receipt_id: 'r3', invoice_id: 'i3', supplier_tax_invoices: null },
    ])
    expect(m.get('r1')).toEqual({ invoice_id: 'i1', invoice_no: 'INV-1', status: 'draft' })
    expect(m.has('r2')).toBe(false)
    expect(m.get('r3')).toEqual({ invoice_id: 'i3', invoice_no: '', status: '' })
    expect(buildActiveReceiptLinkMap(null).size).toBe(0)
  })
})

describe('eligibility / picker / awaiting', () => {
  const L = links([['r2', { invoice_id: 'other', invoice_no: 'INV-9', status: 'posted' }], ['r3', { invoice_id: 'mine', invoice_no: 'INV-1', status: 'draft' }]])
  const rows = [
    rc('r1', { received_date: '2026-10-07' }), rc('r2', { received_date: '2026-10-01' }), rc('r3', { received_date: '2026-10-03' }),
    rc('r4', {}, { supplier_id: 'OTHER' }), rc('r5', {}, { tax_invoice_mode: 'po' }),
  ]
  it('receiptEligibility', () => {
    expect(receiptEligibility(rows[0], { supplierId: 'S', links: L, invoiceId: 'mine' })).toBe('ok')
    expect(receiptEligibility(rows[1], { supplierId: 'S', links: L, invoiceId: 'mine' })).toBe('linked_elsewhere')
    expect(receiptEligibility(rows[2], { supplierId: 'S', links: L, invoiceId: 'mine' })).toBe('ok')   // linked to THIS invoice
    expect(receiptEligibility(rows[3], { supplierId: 'S', links: L, invoiceId: 'mine' })).toBe('wrong_supplier')
    expect(receiptEligibility(rows[4], { supplierId: 'S', links: L, invoiceId: 'mine' })).toBe('not_delivery')
  })
  it('receiptPickerRows: oldest first, other supplier and po-mode left out', () => {
    const p = receiptPickerRows({ receipts: rows, supplierId: 'S', links: L, invoiceId: 'mine' })
    expect(p.available.map(r => r.id)).toEqual(['r3', 'r1'])
    expect(p.linkedElsewhere.map(x => [x.receipt.id, x.link.invoice_no])).toEqual([['r2', 'INV-9']])
  })
  it('receiptsAwaitingInvoice: null until loaded; no link at all (drafts count as linked); per supplier, oldest first', () => {
    expect(receiptsAwaitingInvoice(null, L)).toBeNull()
    expect(receiptsAwaitingInvoice(rows, null)).toBeNull()
    const g = receiptsAwaitingInvoice([...rows, rc('r6', { received_date: '2026-09-30' }, { supplier_id: 'S2' })], L)
    expect(g.map(x => x.supplierId)).toEqual(['S2', 'OTHER', 'S'])   // by each group's oldest lot: 09-30, 10-05, 10-07
    expect(g.find(x => x.supplierId === 'S').rows.map(r => r.id)).toEqual(['r1'])
  })
  it('receiptTaxInvoiceStatus', () => {
    expect(receiptTaxInvoiceStatus('r3', L)).toEqual({ kind: 'linked', text: 'ใบกำกับ INV-1 (ร่าง)', invoiceId: 'mine' })
    expect(receiptTaxInvoiceStatus('r2', L).text).toBe('ใบกำกับ INV-9')
    expect(receiptTaxInvoiceStatus('r1', L)).toEqual({ kind: 'awaiting', text: 'รอใบกำกับ' })
    expect(receiptTaxInvoiceStatus('r1', null)).toEqual({ kind: null, text: '' })
  })
})

describe('mode defaults, payloads, locks, badges', () => {
  it('defaultTaxInvoiceMode', () => {
    expect(defaultTaxInvoiceMode({ default_tax_invoice_mode: 'delivery' })).toBe('delivery')
    expect(defaultTaxInvoiceMode({})).toBe('po')
    expect(defaultTaxInvoiceMode(null)).toBe('po')
  })
  it('poModePayload: never sends the column when it may not exist', () => {
    expect(poModePayload({ tax_invoice_mode: 'delivery' }, null, true)).toEqual({ tax_invoice_mode: 'delivery' })
    expect(poModePayload({ tax_invoice_mode: 'delivery' }, null, false)).toEqual({})
    expect(poModePayload({ tax_invoice_mode: 'delivery' }, null, null)).toEqual({})
    expect(poModePayload({ tax_invoice_mode: 'x' }, { id: 'P', tax_invoice_mode: 'delivery' }, true)).toEqual({ tax_invoice_mode: 'po' })
    expect(poModePayload({ tax_invoice_mode: 'delivery' }, { id: 'P' }, true)).toEqual({})
  })
  it('supplierModePayload', () => {
    expect(supplierModePayload({ default_tax_invoice_mode: 'delivery' }, null, true)).toEqual({ default_tax_invoice_mode: 'delivery' })
    expect(supplierModePayload({ default_tax_invoice_mode: 'delivery' }, null, false)).toEqual({})
    expect(supplierModePayload({ default_tax_invoice_mode: 'po' }, { id: 'S', default_tax_invoice_mode: 'delivery' }, false)).toEqual({ default_tax_invoice_mode: 'po' })
    expect(supplierModePayload({}, { id: 'S' }, true)).toEqual({})
  })
  it('poModeLockedText: ordered/draft without receipts or active PO link only', () => {
    const idx = new Map([['P2', { receiptIds: new Set(['r1']) }]])
    expect(poModeLockedText({ id: 'P1', status: 'ordered' }, idx, new Map())).toBe('')
    expect(poModeLockedText({ id: 'P1', status: 'draft' }, null, null)).toBe('')
    expect(poModeLockedText({ id: 'P2', status: 'ordered' }, idx, null)).toBe(PO_MODE_LOCKED_TEXT)
    expect(poModeLockedText({ id: 'P1', status: 'received' }, idx, null)).toBe(PO_MODE_LOCKED_TEXT)
    expect(poModeLockedText({ id: 'P1', status: 'ordered' }, idx, new Map([['P1', {}]]))).toBe(PO_MODE_LOCKED_TEXT)
  })
  it('deliveryPoBadge', () => {
    const idx = new Map([['P1', { receiptIds: new Set(['r1', 'r2']) }]])
    const L = new Map([['r1', { invoice_id: 'i', invoice_no: 'INV', status: 'posted' }]])
    expect(deliveryPoBadge(po(), idx, L)).toEqual({ kind: 'awaiting', text: 'รอใบกำกับ 1 ล็อต' })
    expect(deliveryPoBadge(po(), idx, new Map([...L, ['r2', {}]]))).toEqual({ kind: 'linked', text: 'ใบกำกับครบ 2 ล็อต' })
    expect(deliveryPoBadge(po({ id: 'P9' }), idx, L)).toEqual({ kind: 'delivery', text: 'ใบกำกับต่อการส่งของ' })
    expect(deliveryPoBadge(po({ tax_invoice_mode: 'po' }), idx, L)).toEqual({ kind: null, text: '' })
    expect(deliveryPoBadge(po(), null, L)).toEqual({ kind: null, text: '' })
  })
})

describe('PO form mode helpers', () => {
  it('poModeForSupplier: hand-picked wins (survives draft restore); unknown supplier -> po', () => {
    expect(poModeForSupplier({ tax_invoice_mode: 'po' }, { default_tax_invoice_mode: 'delivery' })).toBe('delivery')
    expect(poModeForSupplier({ tax_invoice_mode: 'po', tax_invoice_mode_touched: true }, { default_tax_invoice_mode: 'delivery' })).toBe('po')
    expect(poModeForSupplier({ tax_invoice_mode: 'delivery' }, undefined)).toBe('po')
  })
  it('poDeliveryDiscountWarning', () => {
    const lt = it => Number(it.quantity) * Number(it.unit_price)
    expect(poDeliveryDiscountWarning({ tax_invoice_mode: 'delivery', items: [{ description: 'a', quantity: 1, unit_price: 10 }, { description: 'ส่วนลด', quantity: 1, unit_price: -5 }] }, lt)).toBe(PO_DELIVERY_DISCOUNT_SAVE_TEXT)
    expect(poDeliveryDiscountWarning({ tax_invoice_mode: 'po', items: [{ description: 'ส่วนลด', quantity: 1, unit_price: -5 }] }, lt)).toBe('')
    expect(poDeliveryDiscountWarning({ tax_invoice_mode: 'delivery', items: [{ description: '', quantity: 1, unit_price: -5 }] }, lt)).toBe('')
  })
  it('splitDeliveryPoIds: stale delivery POs separated from a PO-kind selection', () => {
    expect(splitDeliveryPoIds(['a', 'b', 'z'], [{ id: 'a' }, { id: 'b', tax_invoice_mode: 'delivery' }])).toEqual({ keep: ['a', 'z'], delivery: ['b'] })
    expect(splitDeliveryPoIds(['a'], null)).toEqual({ keep: ['a'], delivery: [] })
  })
})

describe('formForReceipt (hand-off prefill)', () => {
  const item = (o = {}) => ({ description: 'เหล็ก', unit: 'kg', quantity: 2, unit_price: 321, discount_pct: 0, line_total: 642, inventory_item_id: 'I1', ...o })
  it('VAT-inclusive PO: unit price ex-VAT; stored base quantity kept as typed; net/VAT/date from the receipt', () => {
    const f = formForReceipt(rc('r1', { goods_subtotal: 600, goods_vat: 42, received_date: '2026-10-04',
      po_receipt_items: [{ quantity: 2, base_qty: 2, purchase_order_items: item() }] }, { price_includes_vat: true }), '2026-10-08')
    expect(f).toMatchObject({ supplier_id: 'S', link_kind: 'delivery', receipt_ids: ['r1'], po_ids: [], net_before_vat: '600', vat: '42', invoice_date: '2026-10-04', invoice_no: '' })
    expect(f.lines[0]).toMatchObject({ description: 'เหล็ก', qty: '2', unit: 'kg', unit_price: '300', inventory_item_id: 'I1', site_id: 'SITE', base_qty: '2', base_manual: true })
  })
  it('no stored base (PO "stock from invoice"): base left empty and NOT manual (the form converts it)', () => {
    const f = formForReceipt(rc('r1', { po_receipt_items: [{ quantity: 2, base_qty: null, purchase_order_items: item() }] }, { stock_from_invoice: true }), '2026-10-08')
    expect(f.lines[0]).toMatchObject({ inventory_item_id: 'I1', site_id: 'SITE', base_qty: '', base_manual: false })
  })
  it('non-stock line: no item, no site', () => {
    const f = formForReceipt(rc('r1', { po_receipt_items: [{ quantity: 1, purchase_order_items: item({ inventory_item_id: null }) }] }), '2026-10-08')
    expect(f.lines[0]).toMatchObject({ inventory_item_id: '', site_id: '', base_qty: '' })
  })
})

describe('list helpers', () => {
  it('invoiceMatchBase / linkKindOf', () => {
    const d = { status: 'posted', post_result: { checks: [] }, supplier_tax_invoice_receipts: [{ active: true, goods_subtotal: 400, goods_vat: 28 }, { active: true, goods_subtotal: 1000, goods_vat: 70 }] }
    expect(linkKindOf(d)).toBe('delivery')
    expect(invoiceMatchBase(d)).toBe(1400)
    expect(invoiceMatchBase({ ...d, post_result: { checks: [{ code: 'match_vat_inclusive' }] } })).toBe(1498)
    const p = { status: 'posted', supplier_tax_invoice_pos: [{ active: true, po_subtotal: 1000 }, { active: false, po_subtotal: 5 }] }
    expect(linkKindOf(p)).toBe('po')
    expect(invoiceMatchBase(p)).toBe(1000)
    expect(invoiceMatchBase({ ...p, status: 'void' })).toBe(1005)
  })
})

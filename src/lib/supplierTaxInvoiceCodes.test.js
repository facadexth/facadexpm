import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { CHECK_TEXT, GENERIC_ERROR_TEXT, mapTaxInvoiceRpcError } from './supplierTaxInvoice.js'
import { DELIVERY_CHECK_TEXT, DELIVERY_RPC_TEXT } from './deliveryTaxInvoiceText.js'
import { PO_RECEIPT_ERROR_TEXT } from './poReceiptErrors.js'

// Locks the JS error-code lists to the SQL: every code the migrations can raise or report
// must have Thai text, and every blocking/warning code in CHECK_TEXT must exist in _sti_check.
const read = f => readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8')
const sql1 = read('2026-10-08-01-supplier-tax-invoices.sql')
const sql2 = read('2026-10-08-02-supplier-tax-invoice-rpcs.sql')
const sql4 = read('2026-10-09-04-delivery-tax-invoice.sql')
const sql5 = read('2026-10-09-05-delivery-tax-invoice-rpcs.sql')

const raised = new Set([...(sql1 + sql2 + sql4 + sql5).matchAll(/RAISE EXCEPTION '([a-z_]+)'/g)].map(m => m[1]))
// Codes that are not user-facing (plain developer messages in helpers) are excluded by shape:
// the helpers use sentences with spaces, which the regex above does not match.
const checkBody = sql2.slice(sql2.indexOf('FUNCTION _sti_check'), sql2.indexOf('FUNCTION save_supplier_tax_invoice_draft'))
const checkCodes = new Set([...checkBody.matchAll(/'code', (?:CASE WHEN [^']*?THEN )?'([a-z_]+)'/g)].map(m => m[1]))
for (const m of checkBody.matchAll(/ELSE '([a-z_]+)' END/g)) checkCodes.add(m[1])
for (const m of sql5.matchAll(/'code', (?:CASE WHEN [^']*?THEN )?'([a-z_]+)'/g)) checkCodes.add(m[1])
for (const m of sql5.matchAll(/ELSE '([a-z_]+)' END/g)) checkCodes.add(m[1])

// codes reported as warnings by void (outside _sti_check)
const reported = new Set([...(sql2 + sql5).matchAll(/jsonb_build_object\('code', '([a-z_]+)'/g)].map(m => m[1]))

describe('SQL error codes <-> supplierTaxInvoice.js text', () => {
  it('finds a sane number of codes (guards against a broken regex)', () => {
    expect(raised.size).toBeGreaterThan(10)
    expect(checkCodes.size).toBeGreaterThan(15)
  })
  it('every RAISE EXCEPTION code has Thai text', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const missing = [...raised].filter(c => mapTaxInvoiceRpcError({ message: c }) === GENERIC_ERROR_TEXT)
    spy.mockRestore()
    expect(missing).toEqual([])
  })
  it('every _sti_check code has text in CHECK_TEXT', () => {
    const missing = [...checkCodes].filter(c => !(c in CHECK_TEXT))
    expect(missing).toEqual([])
  })
  it('every code reported by post/void has text in CHECK_TEXT', () => {
    expect([...reported].filter(c => !(c in CHECK_TEXT))).toEqual([])
  })
  it('every CHECK_TEXT code is produced by _sti_check, reported by void, or raised by an RPC', () => {
    const unknown = Object.keys(CHECK_TEXT).filter(c => !checkCodes.has(c) && !raised.has(c) && !reported.has(c))
    expect(unknown).toEqual([])
  })
  it('delivery codes are covered', () => {
    for (const c of ['receipt_wrong_supplier', 'match_vat_inclusive', 'po_is_delivery_mode', 'invoice_mixed_links', 'receipt_no_stock_movements']) expect(checkCodes.has(c), c).toBe(true)
    for (const c of ['po_mode_locked', 'receipt_not_eligible', 'no_receipts']) expect(raised.has(c), c).toBe(true)
    expect(mapTaxInvoiceRpcError({ code: '23505', message: 'duplicate key value violates unique constraint "stirc_receipt_active_uq"' })).toBe(CHECK_TEXT.receipt_linked_elsewhere)
  })
  it('every non-blocking warning code reported by 05 has text', () => {
    for (const c of ['vat_rate_mismatch', 'match_vat_inclusive', 'receipt_no_stock_movements', 'receipt_no_expense', 'receipt_has_deposit', 'receipt_outside_month', 'receipt_stock_from_invoice']) expect(CHECK_TEXT[c], c).toBeTruthy()
  })
  it('expense_missing stays out of the delivery map (the PO wording is not overridden)', () => {
    expect('expense_missing' in DELIVERY_CHECK_TEXT).toBe(false)
    expect(CHECK_TEXT.expense_missing).toMatch(/ใบสั่งซื้อ/)
  })
  it('merge order: delivery maps never override an existing PO wording', () => {
    const existing = { ...CHECK_TEXT }
    for (const k of Object.keys({ ...DELIVERY_CHECK_TEXT, ...DELIVERY_RPC_TEXT })) {
      // a key present in both the delivery map and the PO-side map must carry the same text (no silent override)
      if (k in PO_RECEIPT_ERROR_TEXT && k in DELIVERY_RPC_TEXT) expect(PO_RECEIPT_ERROR_TEXT[k], k).toBe(DELIVERY_RPC_TEXT[k])
      if (k in existing && k in DELIVERY_CHECK_TEXT) expect(existing[k], k).toBe(DELIVERY_CHECK_TEXT[k])
    }
    for (const k of ['po_linked_elsewhere', 'po_has_deposit', 'po_no_expense', 'expense_missing', 'po_has_credit_note']) expect(k in DELIVERY_CHECK_TEXT, k).toBe(false)
  })
})

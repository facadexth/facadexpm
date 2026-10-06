import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { CHECK_TEXT, mapTaxInvoiceRpcError } from './supplierTaxInvoice.js'

// Locks the JS error-code lists to the SQL: every code the migrations can raise or report
// must have Thai text, and every blocking/warning code in CHECK_TEXT must exist in _sti_check.
const read = f => readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8')
const sql1 = read('2026-10-08-01-supplier-tax-invoices.sql')
const sql2 = read('2026-10-08-02-supplier-tax-invoice-rpcs.sql')

const raised = new Set([...(sql1 + sql2).matchAll(/RAISE EXCEPTION '([a-z_]+)'/g)].map(m => m[1]))
// Codes that are not user-facing (plain developer messages in helpers) are excluded by shape:
// the helpers use sentences with spaces, which the regex above does not match.
const checkBody = sql2.slice(sql2.indexOf('FUNCTION _sti_check'), sql2.indexOf('FUNCTION save_supplier_tax_invoice_draft'))
const checkCodes = new Set([...checkBody.matchAll(/'code', (?:CASE WHEN [^']*?THEN )?'([a-z_]+)'/g)].map(m => m[1]))
for (const m of checkBody.matchAll(/ELSE '([a-z_]+)' END/g)) checkCodes.add(m[1])

// codes reported as warnings by void (outside _sti_check)
const reported = new Set([...sql2.matchAll(/jsonb_build_object\('code', '([a-z_]+)'/g)].map(m => m[1]))

describe('SQL error codes <-> supplierTaxInvoice.js text', () => {
  it('finds a sane number of codes (guards against a broken regex)', () => {
    expect(raised.size).toBeGreaterThan(10)
    expect(checkCodes.size).toBeGreaterThan(15)
  })
  it('every RAISE EXCEPTION code has Thai text', () => {
    const missing = [...raised].filter(c => mapTaxInvoiceRpcError({ message: c }) === c)
    expect(missing).toEqual([])
  })
  it('every _sti_check code has text in CHECK_TEXT', () => {
    const missing = [...checkCodes].filter(c => !(c in CHECK_TEXT))
    expect(missing).toEqual([])
  })
  it('every CHECK_TEXT code is produced by _sti_check, reported by void, or raised by an RPC', () => {
    const unknown = Object.keys(CHECK_TEXT).filter(c => !checkCodes.has(c) && !raised.has(c) && !reported.has(c))
    expect(unknown).toEqual([])
  })
})

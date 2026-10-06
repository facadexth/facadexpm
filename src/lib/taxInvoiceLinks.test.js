import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildActiveLinkMap, saveDraftArgs, idArgs, voidArgs, TAX_INVOICE_RPCS } from './taxInvoiceLinks.js'
import { mapTaxInvoiceRpcError, CHECK_TEXT } from './supplierTaxInvoice.js'

describe('buildActiveLinkMap', () => {
  it('maps po_id -> invoice, skipping rows without an embedded invoice', () => {
    const m = buildActiveLinkMap([
      { po_id: 'p1', invoice_id: 'i1', supplier_tax_invoices: { invoice_no: 'INV-1', status: 'posted' } },
      { po_id: 'p2', invoice_id: 'i2', supplier_tax_invoices: null },
    ])
    expect(m.get('p1')).toEqual({ invoice_id: 'i1', invoice_no: 'INV-1', status: 'posted' })
    expect(m.get('p2')).toEqual({ invoice_id: 'i2', invoice_no: '', status: '' })
  })
  it('skips inactive rows; a PO relinked after a void points at the new invoice', () => {
    const m = buildActiveLinkMap([
      { po_id: 'p1', invoice_id: 'old', active: false, supplier_tax_invoices: { invoice_no: 'INV-OLD', status: 'void' } },
      { po_id: 'p1', invoice_id: 'new', active: true, supplier_tax_invoices: { invoice_no: 'INV-NEW', status: 'draft' } },
      { po_id: 'p2', invoice_id: 'old', active: false, supplier_tax_invoices: { invoice_no: 'INV-OLD', status: 'void' } },
    ])
    expect(m.get('p1')).toEqual({ invoice_id: 'new', invoice_no: 'INV-NEW', status: 'draft' })
    expect(m.has('p2')).toBe(false)
    expect(m.size).toBe(1)
  })
  it('many POs on one invoice', () => {
    const rows = ['a', 'b', 'c'].map(po => ({ po_id: po, invoice_id: 'i1', active: true, supplier_tax_invoices: { invoice_no: 'INV-1', status: 'posted' } }))
    const m = buildActiveLinkMap(rows)
    expect([...m.keys()]).toEqual(['a', 'b', 'c'])
    expect([...m.values()].every(v => v.invoice_id === 'i1')).toBe(true)
  })
  it('null/undefined rows -> empty map (table missing before the migration)', () => {
    expect(buildActiveLinkMap(null).size).toBe(0)
    expect(buildActiveLinkMap(undefined).size).toBe(0)
  })
})

describe('RPC argument builders match the SQL function signatures', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql', import.meta.url), 'utf8')
  const paramsOf = fn => {
    const m = sql.match(new RegExp(`FUNCTION ${fn}\\(([^)]*)\\)`))
    expect(m, `function ${fn} in migration`).toBeTruthy()
    return m[1].split(',').map(a => a.trim().split(/\s+/)[0]).sort()
  }
  it('save', () => {
    expect(Object.keys(saveDraftArgs(null, {}, [], [])).sort()).toEqual(paramsOf(TAX_INVOICE_RPCS.save))
  })
  it('delete / preview / post', () => {
    for (const fn of [TAX_INVOICE_RPCS.delete, TAX_INVOICE_RPCS.preview, TAX_INVOICE_RPCS.post]) {
      expect(Object.keys(idArgs('x')).sort()).toEqual(paramsOf(fn))
    }
  })
  it('void', () => {
    expect(Object.keys(voidArgs('x', 'r')).sort()).toEqual(paramsOf(TAX_INVOICE_RPCS.void))
  })
  it('save defaults: a new draft sends p_id null and arrays', () => {
    expect(saveDraftArgs(undefined, { a: 1 }, undefined, undefined)).toEqual({ p_id: null, p_header: { a: 1 }, p_items: [], p_po_ids: [] })
    expect(saveDraftArgs('abc', {}, [1], ['p'])).toEqual({ p_id: 'abc', p_header: {}, p_items: [1], p_po_ids: ['p'] })
  })
})

describe('hooks file wiring', () => {
  const hooks = readFileSync(new URL('../hooks/useSupabase.js', import.meta.url), 'utf8')
  const mig1 = readFileSync(new URL('../../supabase/migrations/2026-10-08-01-supplier-tax-invoices.sql', import.meta.url), 'utf8')
  it('every embed constraint name exists in migration 01 and is used by the hooks', () => {
    for (const c of ['sti_supplier_fk', 'stii_invoice_fk', 'stip_invoice_fk', 'stip_po_fk']) {
      expect(mig1).toContain(`CONSTRAINT ${c} FOREIGN KEY`)
      expect(hooks).toContain(`!${c}(`)
    }
  })
  it('each wrapper calls its own RPC entry (post must not call preview)', () => {
    const want = {
      saveSupplierTaxInvoiceDraft: 'save', deleteSupplierTaxInvoiceDraft: 'delete', previewSupplierTaxInvoice: 'preview',
      postSupplierTaxInvoice: 'post', voidSupplierTaxInvoice: 'void',
    }
    for (const [fn, key] of Object.entries(want)) {
      const line = hooks.split('\n').find(l => l.startsWith(`export const ${fn} =`))
      expect(line, fn).toBeTruthy()
      expect(line).toContain(`TAX_INVOICE_RPCS.${key},`)
    }
  })
})

describe('error mapping for the wrappers (thrown Supabase error objects)', () => {
  it('maps the codes the UI must show', () => {
    for (const code of ['po_tax_invoiced', 'po_data_not_finite', 'void_inexact', 'not_draft', 'bad_header']) {
      const text = mapTaxInvoiceRpcError({ message: code })
      expect(text).not.toBe(code)
      expect(text.length).toBeGreaterThan(5)
    }
    expect(mapTaxInvoiceRpcError({ message: 'po_data_not_finite' })).toBe(CHECK_TEXT.po_data_not_finite)
  })
  it('maps a Postgres deadlock (40P01) to a retry message', () => {
    expect(mapTaxInvoiceRpcError({ code: '40P01', message: 'deadlock detected' })).toMatch(/ลองใหม่/)
    expect(mapTaxInvoiceRpcError({ message: 'deadlock detected' })).toMatch(/ลองใหม่/)
  })
  it('maps a missing function/table (migration not applied) to a clear message', () => {
    expect(mapTaxInvoiceRpcError({ code: 'PGRST202', message: 'Could not find the function public.post_supplier_tax_invoice' })).toMatch(/ยังไม่พร้อม/)
    expect(mapTaxInvoiceRpcError({ code: '42P01', message: 'relation "supplier_tax_invoices" does not exist' })).toMatch(/ยังไม่พร้อม/)
  })
})

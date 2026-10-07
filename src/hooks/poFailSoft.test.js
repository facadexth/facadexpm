import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isMissingRelationError } from '../lib/poReceiptErrors.js'

// Chainable supabase fake: table -> result ({data,error}) or a function of the select string.
const results = {}
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (table) => {
      let sel = ''
      const q = {
        select: (s) => { sel = s; return q }, eq: () => q, not: () => q, order: () => q, range: () => q, limit: () => q,
        maybeSingle: () => q,
        then: (res, rej) => Promise.resolve(typeof results[table] === 'function' ? results[table](sel) : results[table]).then(res, rej),
      }
      return q
    },
  },
}))
const { fetchPoMoneyIndex, fetchPoLedger } = await import('./useSupabase.js')

const relErr = { code: '42P01', message: 'relation "po_receipt_items" does not exist' }

describe('isMissingRelationError', () => {
  it('detects missing tables only', () => {
    expect(isMissingRelationError({ code: '42P01' })).toBe(true)
    expect(isMissingRelationError({ code: 'PGRST205', message: 'x' })).toBe(true)
    expect(isMissingRelationError({ message: 'relation "po_receipts" does not exist' })).toBe(true)
    expect(isMissingRelationError({ message: "Could not find the table 'public.po_receipts' in the schema cache" })).toBe(true)
    expect(isMissingRelationError({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isMissingRelationError(null)).toBe(false)
  })
})

describe('fail soft before the migrations', () => {
  beforeEach(() => { for (const k of Object.keys(results)) delete results[k] })

  it('money index: missing new tables -> empty index', async () => {
    results.po_receipt_items = { data: null, error: relErr }
    results.supplier_deposits = { data: [], error: null }
    const idx = await fetchPoMoneyIndex()
    expect(idx instanceof Map && idx.size === 0).toBe(true)
  })
  it('money index: other errors still surface', async () => {
    results.po_receipt_items = { data: null, error: { code: '42501', message: 'permission denied' } }
    results.supplier_deposits = { data: [], error: null }
    await expect(fetchPoMoneyIndex()).rejects.toBeTruthy()
  })
  it('ledger: new tables missing, legacy deposit applications still returned', async () => {
    results.po_receipts = { data: null, error: relErr }
    results.supplier_deposits = { data: null, error: { code: '42703', message: 'column supplier_deposits.pct_of_po does not exist' } }
    results.po_deposit_applications = (sel) => sel.includes('receipt_id')
      ? { data: null, error: { code: '42703', message: 'column po_deposit_applications.receipt_id does not exist' } }
      : { data: [{ amount_no_vat: 100, vat: 7, supplier_deposits: { deposit_invoice_no: 'DEP-1' } }], error: null }
    results.expenses = { data: [], error: null }
    const l = await fetchPoLedger('P')
    expect(l.receipts).toEqual([])
    expect(l.deposit).toBe(null)
    expect(l.applications).toHaveLength(1)
    expect(l.applications[0].supplier_deposits.deposit_invoice_no).toBe('DEP-1')
  })
  it('ledger: unrelated error still throws', async () => {
    results.po_receipts = { data: [], error: null }
    results.supplier_deposits = { data: null, error: null }
    results.po_deposit_applications = { data: [], error: null }
    results.expenses = { data: null, error: { code: '42501', message: 'permission denied' } }
    await expect(fetchPoLedger('P')).rejects.toBeTruthy()
  })
})

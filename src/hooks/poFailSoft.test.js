import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isMissingRelationError } from '../lib/poReceiptErrors.js'

// Chainable supabase fake: table -> result ({data,error}) or a function of the select string.
const results = {}
const rpcResults = {}
const tablesQueried = []
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    rpc: (name) => Promise.resolve(rpcResults[name] || { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name } }),
    from: (table) => {
      tablesQueried.push(table)
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
const { fetchPoMoneyIndex, fetchPoLedger, deliveryReadyProbe, fetchDeliveryReceipts, fetchActiveReceiptLinks } = await import('./useSupabase.js')

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
    results.expenses = { data: [], error: null }
    const idx = await fetchPoMoneyIndex()
    expect(idx instanceof Map && idx.size === 0).toBe(true)
    expect(idx.schemaReady).toBe(false)
  })
  it('money index: other errors still surface', async () => {
    results.po_receipt_items = { data: null, error: { code: '42501', message: 'permission denied' } }
    results.supplier_deposits = { data: [], error: null }
    results.expenses = { data: [], error: null }
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

describe('per-delivery tax invoice fail soft', () => {
  beforeEach(() => { for (const k of Object.keys(results)) delete results[k]; for (const k of Object.keys(rpcResults)) delete rpcResults[k]; tablesQueried.length = 0 })
  const ready = () => { rpcResults.delivery_tax_invoice_ready = { data: true, error: null } }

  it('probe error (PGRST202): not ready, and no table is queried (04 applied alone lights nothing up)', async () => {
    results.po_receipts = { data: [{ id: 'x' }], error: null }
    results.supplier_tax_invoice_receipts = { data: [{ receipt_id: 'r1', active: true }], error: null }
    expect(await deliveryReadyProbe()).toBe(false)
    expect(await fetchDeliveryReceipts()).toEqual({ ready: false, rows: [] })
    const links = await fetchActiveReceiptLinks()
    expect(links.ready).toBe(false)
    expect(links.map.size).toBe(0)
    expect(tablesQueried).toEqual([])
  })
  it('probe returning anything but true is not ready', async () => {
    rpcResults.delivery_tax_invoice_ready = { data: false, error: null }
    expect(await deliveryReadyProbe()).toBe(false)
    rpcResults.delivery_tax_invoice_ready = { data: null, error: null }
    expect(await deliveryReadyProbe()).toBe(false)
  })
  it('receipts: missing column / table -> not ready; other errors rethrown', async () => {
    ready()
    results.po_receipts = { data: null, error: { code: '42703', message: 'column purchase_orders.tax_invoice_mode does not exist' } }
    expect(await fetchDeliveryReceipts()).toEqual({ ready: false, rows: [] })
    results.po_receipts = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.po_receipts'" } }
    expect(await fetchDeliveryReceipts()).toEqual({ ready: false, rows: [] })
    results.po_receipts = { data: null, error: { code: '42501', message: 'permission denied' } }
    await expect(fetchDeliveryReceipts()).rejects.toBeTruthy()
  })
  it('receipts: ready returns rows', async () => {
    ready()
    results.po_receipts = { data: [{ id: 'r1' }], error: null }
    expect(await fetchDeliveryReceipts()).toEqual({ ready: true, rows: [{ id: 'r1' }] })
  })
  it('links: missing table -> not ready with an empty map; rows build the map', async () => {
    ready()
    results.supplier_tax_invoice_receipts = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.supplier_tax_invoice_receipts'" } }
    const a = await fetchActiveReceiptLinks()
    expect(a.ready).toBe(false)
    expect(a.map instanceof Map && a.map.size === 0).toBe(true)
    results.supplier_tax_invoice_receipts = { data: [{ receipt_id: 'r1', invoice_id: 'i1', active: true, supplier_tax_invoices: { invoice_no: 'A', status: 'draft' } }], error: null }
    const b = await fetchActiveReceiptLinks()
    expect(b.ready).toBe(true)
    expect(b.map.get('r1').invoice_no).toBe('A')
  })
})

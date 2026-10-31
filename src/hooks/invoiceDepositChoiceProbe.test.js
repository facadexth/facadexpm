import { describe, it, expect, vi, beforeEach } from 'vitest'

let result = null
const select = vi.fn(() => ({ limit: () => Promise.resolve().then(() => result()) }))
const from = vi.fn(() => ({ select }))
vi.mock('../lib/supabase.js', () => ({ supabase: { from: (...a) => from(...a), rpc: () => ({}) } }))
const { invoiceDepositChoiceReadyProbe, resetInvoiceDepositChoiceProbe } = await import('./useSupabase.js')

describe('invoiceDepositChoiceReadyProbe (2026-10-09-07 live?)', () => {
  beforeEach(() => { resetInvoiceDepositChoiceProbe(); from.mockClear(); select.mockClear() })

  it('true when the column can be selected, asked only once', async () => {
    result = () => ({ data: [], error: null })
    expect(await invoiceDepositChoiceReadyProbe()).toBe(true)
    expect(await invoiceDepositChoiceReadyProbe()).toBe(true)
    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('invoices')
    expect(select).toHaveBeenCalledWith('deposit_deduction_amount')
  })

  it('false before the migration (column missing, 42703)', async () => {
    result = () => ({ data: null, error: { code: '42703', message: 'column invoices.deposit_deduction_amount does not exist' } })
    expect(await invoiceDepositChoiceReadyProbe()).toBe(false)
  })

  it('false (never throws) on a thrown call, and retries next time', async () => {
    result = () => { throw new Error('network') }
    expect(await invoiceDepositChoiceReadyProbe()).toBe(false)
    result = () => ({ data: [], error: null })
    expect(await invoiceDepositChoiceReadyProbe()).toBe(true)
    expect(from).toHaveBeenCalledTimes(2)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// two loads of the create-invoice screen both see "no units yet" and both seed;
// the second must skip the rows the first one inserted instead of failing on the unique key
const calls = []
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (table) => ({
      select: () => ({ in: async () => ({ data: [], error: null }) }),
      insert: async (rows) => { calls.push({ table, op: 'insert', rows }); return { error: { code: '23505', message: 'duplicate key' } } },
      upsert: async (rows, opts) => { calls.push({ table, op: 'upsert', rows, opts }); return { error: null } },
    }),
  },
}))
const { ensureQuotationItemUnits } = await import('./useSupabase.js')

describe('ensureQuotationItemUnits: concurrent seeding', () => {
  beforeEach(() => { calls.length = 0 })

  it('seeds with ON CONFLICT DO NOTHING on (quotation_item_id, unit_index), so a racing second load does not throw', async () => {
    await expect(ensureQuotationItemUnits([{ id: 'qi1', quantity: 2, unit: 'ชุด' }])).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ table: 'quotation_item_units', op: 'upsert', opts: { onConflict: 'quotation_item_id,unit_index', ignoreDuplicates: true } })
    expect(calls[0].rows.length).toBeGreaterThan(0)
  })
})

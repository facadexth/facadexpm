// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const tables = {
  quotation_items: [{ id: 'qi1' }],
  boq_items: [
    { id: 'b1', quotation_item_id: 'qi1', code: '1', unit: 'ตร.ม.', planned_qty: 26 },
    { id: 'b9', quotation_item_id: 'qi-other', code: '9', unit: 'ชุด', planned_qty: 1 },
  ],
  boq_phase_splits: [{ boq_item_id: 'b1', phase_id: 'p1', pct: 20 }, { boq_item_id: 'b1', phase_id: 'p2', pct: 60 }],
  site_phases: [{ id: 'p1', name: 'ผลิต', sort_order: 1 }, { id: 'p2', name: 'ติดตั้ง', sort_order: 2 }],
  phase_tasks: [{ boq_item_id: 'b1', phase_id: 'p1', done_qty: 26, planned_qty: 26, progress_mode: 'quantity', name: 'กระจก' }],
  invoice_item_phases: [
    { invoice_item_id: 'ii1', boq_item_id: 'b1', phase_id: 'p1', qty: 5 },
    { invoice_item_id: 'ii2', boq_item_id: 'b1', phase_id: 'p1', qty: 8 },
  ],
  invoice_items: [{ id: 'ii1', invoice_id: 'inv1' }, { id: 'ii2', invoice_id: 'inv2' }],
  invoices: [{ id: 'inv1', status: 'void' }, { id: 'inv2', status: 'paid' }],
}
const calls = []
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (t) => {
      const q = {}
      ;['select', 'eq', 'in', 'order', 'not', 'is'].forEach((m) => { q[m] = (...a) => { calls.push([t, m, ...a]); return q } })
      q.range = async () => ({ data: tables[t], error: null })
      return q
    },
  },
}))

import { useProgressBillingData } from './useProgressBillingData.js'

describe('useProgressBillingData', () => {
  it('loads BOQ of the quotation, splits, phases (no issue phases), cards and draws with invoice status', async () => {
    const { result } = renderHook(() => useProgressBillingData('s1', 'q1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    const d = result.current.data
    expect(d.boqByQuotationItem).toEqual({ qi1: { id: 'b1', unit: 'ตร.ม.', planned_qty: 26, code: '1' } })
    expect(d.splitsByBoq).toEqual({ b1: [{ phase_id: 'p1', pct: 20 }, { phase_id: 'p2', pct: 60 }] })
    expect(d.phases).toEqual([{ id: 'p1', name: 'ผลิต', sort_order: 1 }, { id: 'p2', name: 'ติดตั้ง', sort_order: 2 }])
    expect(d.cards).toEqual([{ boq_item_id: 'b1', phase_id: 'p1', done_qty: 26, planned_qty: 26, progress_mode: 'quantity', name: 'กระจก' }])
    expect(d.phaseDraws).toEqual([
      { boq_item_id: 'b1', phase_id: 'p1', qty: 5, invoice_status: 'void' },
      { boq_item_id: 'b1', phase_id: 'p1', qty: 8, invoice_status: 'paid' },
    ])
    expect(calls).toContainEqual(['site_phases', 'eq', 'is_issue_phase', false])
  })

  it('returns null data without a site or quotation', async () => {
    const { result } = renderHook(() => useProgressBillingData(null, 'q1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toBeNull()
  })
})

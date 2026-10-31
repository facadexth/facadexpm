// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const fromCalls = []
const rpcCalls = []
const selects = []
const rangeCalls = []
const rpcData = {
  pm_sites: [{ id: 's1', site_number: 'B', name: 'Site B', is_default: false }, { id: 's2', site_number: 'A', name: 'Site A', is_default: true }],
  pm_workers: [
    { id: 'w1', name: 'Ann', nickname: 'A', position: 'tech', status: 'active', show_in_assign: true },
    { id: 'w2', name: 'Bob', nickname: 'B', position: 'tech', status: 'active', show_in_assign: false },
    { id: 'w3', name: 'Cat', nickname: 'C', position: 'tech', status: 'resigned', show_in_assign: true },
  ],
}
const tableData = { worker_assignments: [{ id: 'a1', worker_id: 'w1', site_id: 's1', date: '2026-10-01' }], site_financial_summary: [] }

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    rpc: (name, args) => {
      rpcCalls.push([name, args])
      const rows = rpcData[name] ?? []
      const q = {
        eq: (c, v) => { q.rows = rows.filter(r => r[c] === v); return q },
        range: (a, b) => { rangeCalls.push([name, a, b]); q.rows = rows.slice(a, b + 1); return q },
        single: () => Promise.resolve({ data: (q.rows ?? rows)[0] ?? null, error: null }),
        then: (res, rej) => Promise.resolve({ data: q.rows ?? rows, error: null }).then(res, rej),
      }
      return q
    },
    from: (table) => {
      fromCalls.push(table)
      const q = {
        select: (s) => { selects.push([table, s]); return q }, gte: () => q, lte: () => q, eq: () => q, order: () => q, range: () => q,
        then: (res, rej) => Promise.resolve({ data: tableData[table] ?? [], error: null }).then(res, rej),
      }
      return q
    },
  },
}))

const { setCurrentRole } = await import('../lib/roles.js')
const { useSites, useSite, useSiteOverview, useWorkers, useAllActiveWorkers, useAssignmentsRange, useSitesProgress, useInventoryOnHand } = await import('./useSupabase.js')

beforeEach(() => { fromCalls.length = 0; rpcCalls.length = 0; selects.length = 0; rangeCalls.length = 0; delete rpcData.pm_inventory_on_hand })

describe('PM data hooks', () => {
  it('PM hooks mounted together share one pm_workers request; a later mount fetches fresh', async () => {
    setCurrentRole('PM')
    const a = renderHook(() => useWorkers())
    const b = renderHook(() => useAllActiveWorkers())
    await waitFor(() => expect(a.result.current.loading || b.result.current.loading).toBe(false))
    await waitFor(() => expect(b.result.current.loading).toBe(false))
    const firstPages = rangeCalls.filter(c => c[0] === 'pm_workers' && c[1] === 0).length
    expect(firstPages).toBe(1)
    expect(a.result.current.data.map(w => w.id)).toEqual(['w1'])
    expect(b.result.current.data.map(w => w.id)).toEqual(['w1', 'w2'])
    const c = renderHook(() => useWorkers())
    await waitFor(() => expect(c.result.current.loading).toBe(false))
    expect(rangeCalls.filter(x => x[0] === 'pm_workers' && x[1] === 0).length).toBe(2)
  })
  it('PM useSites uses pm_sites and never the financial view', async () => {
    setCurrentRole('PM')
    const { result } = renderHook(() => useSites())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(rpcCalls[0][0]).toBe('pm_sites')
    expect(fromCalls).not.toContain('site_financial_summary')
    expect(result.current.data.map(s => s.site_number)).toEqual(['A', 'B'])
  })
  it('ADMIN useSites still queries site_financial_summary', async () => {
    setCurrentRole('ADMIN')
    const { result } = renderHook(() => useSites())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fromCalls).toContain('site_financial_summary')
    expect(rpcCalls).toHaveLength(0)
  })
  it('PM useSite / useSiteOverview filter pm_sites by id; overview has null money', async () => {
    setCurrentRole('PM')
    const a = renderHook(() => useSite('s1'))
    const b = renderHook(() => useSiteOverview('s1'))
    await waitFor(() => expect(a.result.current.loading || b.result.current.loading).toBe(false))
    expect(a.result.current.data.name).toBe('Site B')
    expect(b.result.current.data).toMatchObject({ id: 's1', deposit: null, retention: null })
    expect(fromCalls).toHaveLength(0)
  })
  it('PM useSitesProgress returns empty without querying', async () => {
    setCurrentRole('PM')
    const { result } = renderHook(() => useSitesProgress())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual([])
    expect(fromCalls).toHaveLength(0)
  })
  it('PM workers are filtered like the originals', async () => {
    setCurrentRole('PM')
    const a = renderHook(() => useWorkers())
    const b = renderHook(() => useAllActiveWorkers())
    await waitFor(() => expect(a.result.current.loading || b.result.current.loading).toBe(false))
    expect(a.result.current.data.map(w => w.id)).toEqual(['w1'])
    expect(b.result.current.data.map(w => w.id)).toEqual(['w1', 'w2'])
  })
  it('PM useAssignmentsRange selects no money and attaches names', async () => {
    setCurrentRole('PM')
    const { result } = renderHook(() => useAssignmentsRange('2026-10-01', '2026-10-31'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const sel = selects.find(([t]) => t === 'worker_assignments')[1]
    expect(sel).not.toContain('monthly_salary')
    expect(sel).not.toContain('workers(')
    expect(sel).not.toContain('sites(')
    expect(result.current.data[0].workers).toEqual({ name: 'Ann', nickname: 'A', position: 'tech' })
    expect(result.current.data[0].sites).toEqual({ name: 'Site B', site_number: 'B', is_default: false })
  })
  it('PM RPC reads fetch a second page after a full first page of 1000 rows', async () => {
    setCurrentRole('PM')
    rpcData.pm_inventory_on_hand = Array.from({ length: 1001 }, (_, i) => ({ inventory_item_id: 'i' + i, quantity_on_hand: '2' }))
    const { result } = renderHook(() => useInventoryOnHand('s1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(Object.keys(result.current.data)).toHaveLength(1001)
    expect(rangeCalls.filter(c => c[0] === 'pm_inventory_on_hand').map(c => c[1])).toEqual([0, 1000])
  })
})

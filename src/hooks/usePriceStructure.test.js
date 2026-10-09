import { describe, it, expect, vi } from 'vitest'

vi.mock('../lib/supabase.js', () => ({ supabase: {} }))
const { fetchPriceStructure } = await import('./usePriceStructure.js')

function fakeClient(tables) {
  const calls = []
  return {
    calls,
    from(table) {
      const st = { table, eq: [], order: [] }
      calls.push(st)
      const b = {
        select() { return b }, eq(c, v) { st.eq.push([c, v]); return b }, order(c, o) { st.order.push([c, o]); return b },
        range() { return Promise.resolve({ data: tables[table].filter(r => st.eq.every(([c, v]) => r[c] === v)), error: null }) },
      }
      return b
    },
  }
}

describe('fetchPriceStructure query shape', () => {
  it('filters every table by project_id in SQL and orders snapshots by created_at', async () => {
    const c = fakeClient({
      estimation_quotation_links: [{ id: 'l1', project_id: 'p1' }, { id: 'l2', project_id: 'p2' }],
      estimation_quotation_lines: [{ id: 'x1', project_id: 'p1' }, { id: 'x2', project_id: 'p2' }],
      estimation_price_snapshots: [{ id: 's1', project_id: 'p1', created_at: '1' }, { id: 's2', project_id: 'p2', created_at: '2' }],
    })
    const r = await fetchPriceStructure(c, 'p1')
    expect(c.calls).toHaveLength(3)
    for (const call of c.calls) expect(call.eq).toEqual([['project_id', 'p1']])
    expect(c.calls.find(x => x.table === 'estimation_price_snapshots').order[0]).toEqual(['created_at', { ascending: true }])
    expect(r.link.id).toBe('l1'); expect(r.lines.map(l => l.id)).toEqual(['x1']); expect(r.snapshots.map(s => s.id)).toEqual(['s1'])
  })
  it('no project id: no queries', async () => {
    const c = fakeClient({})
    expect(await fetchPriceStructure(c, null)).toEqual({ link: null, lines: [], snapshots: [] })
    expect(c.calls).toHaveLength(0)
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'

// from(...).select().in(ids).order().order().range(from, to) -> one page of the
// fixture rows for those ids. Records every (ids, range) pair.
const requests = []
let rowsFor = () => []
const chain = () => {
  const q = { ids: null }
  q.select = () => q
  q.in = (_col, ids) => { q.ids = ids; return q }
  q.order = () => q
  q.range = async (from, to) => {
    requests.push({ ids: q.ids, from, to })
    const all = rowsFor(q.ids)
    return { data: all.slice(from, to + 1), error: null }
  }
  return q
}
vi.mock('../../lib/supabase.js', () => ({ supabase: { from: () => chain() } }))

import { fetchBoqPhaseSplits, SPLIT_ID_CHUNK } from './useBoqPhaseSplits.js'

afterEach(() => { requests.length = 0; rowsFor = () => [] })

describe('fetchBoqPhaseSplits', () => {
  it('splits the ids into chunks of at most 100 per .in() and keeps every row', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `b${i}`)
    rowsFor = (chunk) => chunk.map((id) => ({ boq_item_id: id, phase_id: 'p', pct: 1 }))
    const rows = await fetchBoqPhaseSplits(ids)
    expect(SPLIT_ID_CHUNK).toBe(100)
    expect(requests.map((r) => r.ids.length)).toEqual([100, 100, 50])
    expect(requests.every((r) => r.ids.length <= 100)).toBe(true)
    expect(rows.length).toBe(250)
    expect(new Set(rows.map((r) => r.boq_item_id)).size).toBe(250)
  })
  it('pages a chunk with .range() past the 1000-row cap', async () => {
    // 60 items x 20 phases = 1200 rows in one chunk
    const ids = Array.from({ length: 60 }, (_, i) => `b${i}`)
    rowsFor = (chunk) => chunk.flatMap((id) => Array.from({ length: 20 }, (_, p) => ({ boq_item_id: id, phase_id: `p${p}`, pct: 5 })))
    const rows = await fetchBoqPhaseSplits(ids)
    expect(rows.length).toBe(1200)
    expect(requests.map((r) => [r.from, r.to])).toEqual([[0, 999], [1000, 1999]])
  })
  it('no ids -> no request', async () => {
    expect(await fetchBoqPhaseSplits([])).toEqual([])
    expect(requests.length).toBe(0)
  })
})

import { describe, it, expect, vi } from 'vitest'

vi.mock('../supabase.js', () => ({ supabase: {} }))
import { fetchAllPages, chunk } from './load.js'

// Fake query builder: ordered range() over a fixed table, like PostgREST.
function fakeTable(n) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1 }))
  const calls = []
  const build = () => ({
    order() { return this },
    range(a, b) { calls.push([a, b]); return Promise.resolve({ data: rows.slice(a, b + 1), error: null }) },
  })
  return { build, calls }
}

describe('fetchAllPages', () => {
  it('keeps fetching until a short page comes back', async () => {
    const t = fakeTable(2500)
    const out = await fetchAllPages(t.build)
    expect(out).toHaveLength(2500)
    expect(t.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
  it('does one extra fetch when the total is an exact multiple of a page', async () => {
    const t = fakeTable(1000)
    expect(await fetchAllPages(t.build)).toHaveLength(1000)
    expect(t.calls).toHaveLength(2)
  })
  it('returns [] for an empty table', async () => {
    expect(await fetchAllPages(fakeTable(0).build)).toEqual([])
  })
  it('throws the supabase error', async () => {
    const build = () => ({ order() { return this }, range: () => Promise.resolve({ data: null, error: new Error('boom') }) })
    await expect(fetchAllPages(build)).rejects.toThrow('boom')
  })
})

describe('chunk', () => {
  it('splits into groups of 100', () => {
    const parts = chunk(Array.from({ length: 250 }, (_, i) => i))
    expect(parts.map(p => p.length)).toEqual([100, 100, 50])
  })
})

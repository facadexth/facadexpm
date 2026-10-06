import { describe, it, expect } from 'vitest'
import { fetchAllRows } from './fetchAllRows.js'

const fakeTable = n => {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i }))
  const calls = []
  return { calls, build: () => ({ range: (a, b) => { calls.push([a, b]); return Promise.resolve({ data: rows.slice(a, b + 1), error: null }) } }) }
}

describe('fetchAllRows', () => {
  it('reads past the 1000-row cap (2058 rows -> 3 pages)', async () => {
    const t = fakeTable(2058)
    const all = await fetchAllRows(t.build)
    expect(all).toHaveLength(2058)
    expect(t.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
  it('exact multiple of page size asks for one more (empty) page', async () => {
    const t = fakeTable(2000)
    expect(await fetchAllRows(t.build)).toHaveLength(2000)
    expect(t.calls).toHaveLength(3)
  })
  it('throws on error', async () => {
    await expect(fetchAllRows(() => ({ range: () => Promise.resolve({ data: null, error: new Error('x') }) }))).rejects.toThrow('x')
  })
})

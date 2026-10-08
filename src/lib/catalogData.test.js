// src/lib/catalogData.test.js
import { describe, it, expect } from 'vitest'
import { fetchCatalogRows } from './catalogData.js'

function fakeClient(total) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: String(i) }))
  const orders = []
  return {
    orders,
    from() {
      const q = {
        select() { return q },
        order(col, opts) { orders.push([col, opts]); return q },
        range(a, b) { return Promise.resolve({ data: rows.slice(a, b + 1), error: null }) },
      }
      return q
    },
  }
}

describe('fetchCatalogRows', () => {
  it('returns every row past the 1000-row response cap', async () => {
    const rows = await fetchCatalogRows(fakeClient(1005), 'alu_kg_prices', 'effective_from', false)
    expect(rows).toHaveLength(1005)
  })
  it('orders by the requested column with id as a stable tie-breaker', async () => {
    const client = fakeClient(3)
    await fetchCatalogRows(client, 'alu_series', 'name')
    expect(client.orders).toContainEqual(['name', { ascending: true }])
    expect(client.orders.some(([col]) => col === 'id')).toBe(true)
  })
  it('surfaces a database error', async () => {
    const client = { from: () => ({ select() { return this }, order() { return this }, range: () => Promise.resolve({ data: null, error: new Error('boom') }) }) }
    await expect(fetchCatalogRows(client, 'alu_series')).rejects.toThrow('boom')
  })
})

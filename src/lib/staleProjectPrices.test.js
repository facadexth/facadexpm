// src/lib/staleProjectPrices.test.js
import { describe, it, expect } from 'vitest'
import { listPriceChanges } from './staleProjectPrices.js'

const bom = (o = {}) => ({
  profileLines: [{ role_name: 'Top rail', price_row_id: 'k1' }],
  gridLines: [],
  hardwareLines: [{ name: 'Lock', price_row_id: null }],
  hardwareSetLines: [{ name: 'Hinge', price_row_id: 'pp1' }],
  ...o,
})

describe('listPriceChanges', () => {
  it('reports nothing when the locked and current runs used the same price rows', () => {
    expect(listPriceChanges({ a: bom() }, { a: bom() })).toEqual([])
  })

  it('reports a line whose price row changed (a newer price took effect) (Review Focus 3)', () => {
    const current = bom({ profileLines: [{ role_name: 'Top rail', price_row_id: 'k2' }] })
    expect(listPriceChanges({ a: bom() }, { a: current })).toEqual([{ opening_id: 'a', name: 'Top rail', before: 'k1', after: 'k2' }])
  })

  it('covers grid, hardware and hardware-set lines too', () => {
    const locked = bom({ gridLines: [{ role_name: 'Mullion', price_row_id: 'g1' }] })
    const current = bom({
      gridLines: [{ role_name: 'Mullion', price_row_id: 'g2' }],
      hardwareLines: [{ name: 'Lock', price_row_id: 'pp9' }],
      hardwareSetLines: [{ name: 'Hinge', price_row_id: 'pp2' }],
    })
    const names = listPriceChanges({ a: locked }, { a: current }).map(c => c.name).sort()
    expect(names).toEqual(['Hinge', 'Lock', 'Mullion'])
  })

  it('a line that was unresolved and now has a price counts as a change (and the reverse)', () => {
    const locked = bom({ profileLines: [{ role_name: 'Top rail', price_row_id: null }] })
    expect(listPriceChanges({ a: locked }, { a: bom() })).toEqual([{ opening_id: 'a', name: 'Top rail', before: null, after: 'k1' }])
    expect(listPriceChanges({ a: bom() }, { a: locked })).toEqual([{ opening_id: 'a', name: 'Top rail', before: 'k1', after: null }])
  })

  it('keeps the openings apart and ignores ones missing from the current run', () => {
    const changed = bom({ profileLines: [{ role_name: 'Top rail', price_row_id: 'k2' }] })
    const out = listPriceChanges({ a: bom(), b: bom(), gone: bom() }, { a: changed, b: bom() })
    expect(out).toEqual([{ opening_id: 'a', name: 'Top rail', before: 'k1', after: 'k2' }])
  })

  it('tolerates missing arrays and legacy lines without price_row_id', () => {
    expect(listPriceChanges({ a: { profileLines: [{ role_name: 'X' }] } }, { a: { profileLines: [{ role_name: 'X' }] } })).toEqual([])
  })
})

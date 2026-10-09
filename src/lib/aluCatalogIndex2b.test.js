// src/lib/aluCatalogIndex2b.test.js -- the index keys Phase 2b adds to buildCatalogIndex.
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'

describe('buildCatalogIndex Phase 2b keys', () => {
  it('indexes types by id and series types / series parts by series', () => {
    const i = buildCatalogIndex({
      types: [{ id: 't1', name: 'a' }],
      seriesTypes: [{ series_id: 's1', type_id: 't1' }, { series_id: 's1', type_id: 't2' }],
      seriesParts: [{ series_id: 's2', type_id: null, part_id: 'p1' }],
    })
    expect(i.types.t1.name).toBe('a')
    expect(i.seriesTypesBySeries.s1).toHaveLength(2)
    expect(i.seriesPartsBySeries.s2[0].part_id).toBe('p1')
  })
  it('missing tables give empty maps, never undefined', () => {
    const i = buildCatalogIndex({})
    expect(i.types).toEqual({})
    expect(i.seriesTypesBySeries).toEqual({})
    expect(i.seriesPartsBySeries).toEqual({})
  })
})

import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { hardwareSetChoices } from './estimationCatalogViews.js'

const index = buildCatalogIndex({
  types: [{ id: 'slide' }, { id: 'casement' }],
  parts: [
    { id: 'hLinked', kind: 'hardware_set', name: 'B linked' }, { id: 'hType', kind: 'hardware_set', name: 'A slide only' },
    { id: 'hOther', kind: 'hardware_set', name: 'C other series' }, { id: 'hFree', kind: 'hardware_set', name: 'D free' },
    { id: 'hOff', kind: 'hardware_set', name: 'E free off', active: false }, { id: 'p', kind: 'hardware', name: 'a part' },
  ],
  seriesParts: [
    { series_id: 's1', part_id: 'hLinked', type_id: null }, { series_id: 's1', part_id: 'hType', type_id: 'slide' },
    { series_id: 's2', part_id: 'hOther', type_id: null },
  ],
})

describe('hardwareSetChoices', () => {
  it("the series' sets for the type first, then sets linked to no series at all", () => {
    expect(hardwareSetChoices(index, 's1', 'slide').map(p => p.id)).toEqual(['hType', 'hLinked', 'hFree'])
    expect(hardwareSetChoices(index, 's1', 'casement').map(p => p.id)).toEqual(['hLinked', 'hFree'])
  })
  it('no series yet: only the sets usable with any series', () => {
    expect(hardwareSetChoices(index, null, 'slide').map(p => p.id)).toEqual(['hFree'])
  })
})

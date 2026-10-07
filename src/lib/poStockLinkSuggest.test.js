import { describe, it, expect } from 'vitest'
import { suggestStockLinks, normName } from './poStockLinkSuggest.js'

const items = [
  { id: 'I1', name: 'เหล็กกล่อง', active: true },
  { id: 'I2', name: 'Silicone  Black', active: true },
  { id: 'D1', name: 'สกรู', active: true },
  { id: 'D2', name: 'สกรู ', active: true },
  { id: 'X1', name: 'ปูน', active: false },
]
const L = d => ({ description: d })

describe('suggestStockLinks', () => {
  it('exact name match', () => {
    expect(suggestStockLinks([L('เหล็กกล่อง')], items, [])).toEqual(['I1'])
  })
  it('normalises double spaces, case and edges', () => {
    expect(suggestStockLinks([L('  silicone black ')], items, [])).toEqual(['I2'])
    expect(normName('A  B')).toBe('a b')
  })
  it('ambiguous exact-name duplicates give none', () => {
    expect(suggestStockLinks([L('สกรู')], items, [])).toEqual([null])
  })
  it('past PO match wins, also over ambiguity and over a different exact name', () => {
    const past = [{ description: 'สกรู', inventory_item_id: 'D2' }, { description: 'สกรู', inventory_item_id: 'D1' }]
    expect(suggestStockLinks([L('สกรู')], items, past)).toEqual(['D2'])
    expect(suggestStockLinks([L('เหล็กกล่อง')], items, [{ description: 'เหล็กกล่อง', inventory_item_id: 'I2' }])).toEqual(['I2'])
  })
  it('most recent usable past line is used; unusable ones are skipped', () => {
    const past = [
      { description: 'เหล็กกล่อง', inventory_item_id: 'X1' },
      { description: 'เหล็กกล่อง', inventory_item_id: 'GONE' },
      { description: 'เหล็กกล่อง', inventory_item_id: null },
      { description: 'เหล็กกล่อง', inventory_item_id: 'I2' },
    ]
    expect(suggestStockLinks([L('เหล็กกล่อง')], items, past)).toEqual(['I2'])
  })
  it('inactive item and empty description give none', () => {
    expect(suggestStockLinks([L('ปูน'), L(''), L('ไม่มีของนี้')], items, [])).toEqual([null, null, null])
  })
})

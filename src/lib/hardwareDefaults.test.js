import { describe, it, expect } from 'vitest'
import { hardwareDefaults, hardwareDefaultsPlan, hardwareDefaultRows } from './hardwareDefaults.js'
import { registerLayoutForTest } from './layoutRegistry.js'
import sliding_2 from './layouts/sliding_2.js'

const byName = rows => Object.fromEntries(rows.map(r => [r.name, r.quantity]))

describe('hardwareDefaults', () => {
  it('awning_grid 2x2: 4 sashes -> arms 8, handles 4', () => {
    expect(hardwareDefaults('awning_grid', { rows: 2, cols: 2 })).toEqual([
      { name: 'แขนค้ำกระทุ้ง', quantity: 8, per: 'sash', part_id: null, source: 'layout_default' },
      { name: 'มือจับ', quantity: 4, per: 'sash', part_id: null, source: 'layout_default' },
    ])
  })
  it('swing_door pivot, 2 leaves: closer 1, pivots 2 x2, handle 1 x2, no hinges', () => {
    const q = byName(hardwareDefaults('swing_door', { pivot: true, leaves: 2 }))
    expect(q).toEqual({ 'door closer ฝังวงกบบน': 2, 'เดือยบน/ล่าง': 4, 'มือจับ': 2 })
  })
  it('swing_door without pivot: 3 hinges per leaf, no closer or pivots', () => {
    expect(byName(hardwareDefaults('swing_door', { pivot: false, leaves: 1 }))).toEqual({ 'บานพับ': 3, 'มือจับ': 1 })
  })
  it('folding_door nL 3 nR 2: rollers (2+1)*2 = 6 (unit expression)', () => {
    const q = byName(hardwareDefaults('folding_door', { nL: 3, nR: 2 }))
    expect(q['ล้อบน/ล่างบานเฟี้ยม']).toBe(6)
    expect(hardwareDefaults('folding_door', { nL: 3, nR: 2 }).every(r => r.per === 'unit')).toBe(true)
  })
  it('curtain_wall resolves cells_awning', () => {
    const q = byName(hardwareDefaults('curtain_wall', { cells: { '0,0': 'awning', '1,1': 'awning', '2,3': 'awning' } }))
    expect(q).toEqual({ 'แขนค้ำกระทุ้ง': 6, 'มือจับ': 3 })
  })
  it('sliding_2 yields exactly what its layout declares: wheels 4, lock 1', () => {
    expect(byName(hardwareDefaults('sliding_2', {}))).toEqual({ 'ลูกล้อ': 4, 'กุญแจ/มือจับ': 1 })
  })
  it('a layout with no hardware gives nothing', () => {
    expect(hardwareDefaults('fixed_grid', { rows: 2, cols: 2 })).toEqual([])
  })
  it('a row whose expression cannot be evaluated is skipped and reported', () => {
    registerLayoutForTest({ ...sliding_2, kind: 'hw_bad_expr', hardware: [{ name: 'ok', per: 'unit', qty: 2 }, { name: 'bad', per: 'unit', qty: 'nope*2' }] })
    const plan = hardwareDefaultsPlan('hw_bad_expr', {})
    expect(plan.rows.map(r => r.name)).toEqual(['ok'])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0].name).toBe('bad')
    expect(typeof plan.skipped[0].reason).toBe('string')
  })
})

describe('hardwareDefaultRows', () => {
  it('maps to bom_template_hardware columns only', () => {
    expect(hardwareDefaultRows('awning_grid', { rows: 2, cols: 2 })).toEqual([
      { name: 'แขนค้ำกระทุ้ง', reference_unit_price: 0, quantity_basis: 'fixed', quantity_value: 8, part_id: null, sort_order: 0 },
      { name: 'มือจับ', reference_unit_price: 0, quantity_basis: 'fixed', quantity_value: 4, part_id: null, sort_order: 1 },
    ])
  })
  it('sort_order starts after existing rows when offset given', () => {
    expect(hardwareDefaultRows('sliding_2', {}, 3).map(r => r.sort_order)).toEqual([3, 4])
  })
})

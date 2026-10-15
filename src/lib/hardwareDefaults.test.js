import { describe, it, expect } from 'vitest'
import { hardwareDefaults, hardwareDefaultsPlan, hardwareDefaultRows, itemHardwareRows } from './hardwareDefaults.js'
import { startModel, setParams } from './partModel.js'
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
  it('sliding_2 yields exactly what its layout declares: wheels 4, inner lock 2', () => {
    expect(byName(hardwareDefaults('sliding_2', {}))).toEqual({ 'ลูกล้อ': 4, 'มือจับล็อค (ด้านใน)': 2 })
  })
  it('sliding_n counts every sash of its left / middle / right parts (R-F1): wheels 2 per sash', () => {
    expect(byName(hardwareDefaults('sliding_n', { n: 2 }))).toEqual({ 'ลูกล้อ': 4, 'กุญแจ/มือจับ': 1 })
    expect(byName(hardwareDefaults('sliding_n', { n: 3 }))).toEqual({ 'ลูกล้อ': 6, 'กุญแจ/มือจับ': 1 })
    expect(byName(hardwareDefaults('sliding_n', { n: 5 }))).toEqual({ 'ลูกล้อ': 10, 'กุญแจ/มือจับ': 1 })
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

describe('sliding_2 options hardware (Task 9)', () => {
  it('default params (window, 2 sliding): wheels 4, inner lock 2, no outer key (qty 0 row dropped)', () => {
    expect(byName(hardwareDefaults('sliding_2', {}))).toEqual({ 'ลูกล้อ': 4, 'มือจับล็อค (ด้านใน)': 2 })
  })
  it('door, เลื่อน 1 ฟิก 1: wheels 2, inner lock 1, outer key 1', () => {
    expect(byName(hardwareDefaults('sliding_2', { door: true, one_fixed: 1 }))).toEqual({ 'ลูกล้อ': 2, 'มือจับล็อค (ด้านใน)': 1, 'กุญแจ/มือจับเรียบ (ด้านนอก)': 1 })
  })
  it('door, 2 sliding: outer key 2', () => {
    expect(byName(hardwareDefaults('sliding_2', { door: true }))['กุญแจ/มือจับเรียบ (ด้านนอก)']).toBe(2)
  })
})

describe('itemHardwareRows (item options move the layout hardware by their delta)', () => {
  const base = startModel('sliding_2', {})
  const rows = [
    { id: 'h1', name: 'ลูกล้อ', quantity_basis: 'fixed', quantity_value: 6, part_id: 'p1' },        // owner edited 4 -> 6
    { id: 'h2', name: 'มือจับล็อค (ด้านใน)', quantity_basis: 'fixed', quantity_value: 2, part_id: null },
    { id: 'h3', name: 'สักหลาด', quantity_basis: 'per_perimeter_m', quantity_value: 1, part_id: 'p9' },   // owner's own row
  ]
  it('same model (no item override) -> the rows unchanged, same array', () => {
    expect(itemHardwareRows(rows, base, base)).toBe(rows)
  })
  it('door on the item adds the outer key as an unpriced row; the other rows keep the owner\'s quantities', () => {
    const out = itemHardwareRows(rows, base, setParams(base, { door: true }))
    expect(out.map(r => [r.name, r.quantity_value, r.part_id])).toEqual([
      ['ลูกล้อ', 6, 'p1'], ['มือจับล็อค (ด้านใน)', 2, null], ['สักหลาด', 1, 'p9'], ['กุญแจ/มือจับเรียบ (ด้านนอก)', 2, null],
    ])
    expect(out[3]).toMatchObject({ quantity_basis: 'fixed', reference_unit_price: 0, source: 'item_option' })
  })
  it('เลื่อน 1 ฟิก 1 on the item: wheels 6 - 2 = 4, inner lock 2 - 1 = 1 (delta, not the layout default)', () => {
    const out = itemHardwareRows(rows, base, setParams(base, { one_fixed: 1 }))
    expect(out.map(r => [r.name, r.quantity_value])).toEqual([['ลูกล้อ', 4], ['มือจับล็อค (ด้านใน)', 1], ['สักหลาด', 1]])
    expect(out[0]).toMatchObject({ id: 'h1', part_id: 'p1', source: 'item_option' })
  })
  it('a row that would reach 0 is dropped; a template that is a door and an item that is a window removes the key', () => {
    const doorBase = startModel('sliding_2', { door: true })
    const doorRows = [{ name: 'กุญแจ/มือจับเรียบ (ด้านนอก)', quantity_basis: 'fixed', quantity_value: 2, part_id: 'k' }]
    expect(itemHardwareRows(doorRows, doorBase, setParams(doorBase, { door: false }))).toEqual([])
  })
  it('a refused or missing model, or a legacy (no layout) template, leaves the rows alone', () => {
    expect(itemHardwareRows(rows, base, { error: 'layout_params_invalid' })).toBe(rows)
    expect(itemHardwareRows(rows, null, null)).toBe(rows)
    expect(itemHardwareRows(undefined, base, base)).toEqual([])
  })
})

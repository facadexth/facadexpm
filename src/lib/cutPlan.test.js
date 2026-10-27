// src/lib/cutPlan.test.js
import { describe, it, expect } from 'vitest'
import { piecesOf, packWithOffcuts, groupIdenticalBars } from './cutPlan.js'

const S = { kerf_square_mm: 3, kerf_miter_mm: 10, min_keep_offcut_m: 0.5 }
const line = (o) => ({ resolved: true, profile_id: 'P', length_m: 1, quantity: 1, role_name: 'r', cut_style: 'square', cut_ends: 0, ...o })
const entry = (lines, o = {}) => ({ opening_no: 'W-01', item_id: 'i1', item_name: 'บาน', quantity: 1, finish_id: 'F', bom: { profileLines: lines, gridLines: [] }, ...o })
const pc = (len, o = {}) => ({ length_m: len, opening_no: 'W-01', item_name: '', role_name: 'r', end_a: 'square', end_b: 'square', notch: null, kerf_style: 'square', ...o })

describe('piecesOf', () => {
  it('expands quantity x item quantity, keeps the item and both ends', () => {
    const m = piecesOf([entry([line({ length_m: 1.8, quantity: 2, cut_style: 'miter45', cut_ends: 2 })], { quantity: 3 })])
    const ps = m.get('P|F')
    expect(ps).toHaveLength(6)
    expect(ps[0]).toMatchObject({ length_m: 1.8, opening_no: 'W-01', item_id: 'i1', item_name: 'บาน', end_a: 'miter45', end_b: 'miter45', kerf_style: 'miter45' })
  })
  it('one notched end: the other end is square, the notch is described', () => {
    const ps = piecesOf([entry([line({ cut_style: 'notch', cut_ends: 1, joint_name: 'บากรับกรอบนอน', notch_width_mm: 20, notch_depth_mm: 8 })])]).get('P|F')
    expect(ps[0]).toMatchObject({ end_a: 'notch', end_b: 'square', kerf_style: 'square', notch: { joint_name: 'บากรับกรอบนอน', width_mm: 20, depth_mm: 8 } })
  })
  it('a notch line with no sizes keeps a notch with null sizes', () => {
    const ps = piecesOf([entry([line({ cut_style: 'notch', cut_ends: 2, joint_name: null, notch_width_mm: null, notch_depth_mm: null })])]).get('P|F')
    expect(ps[0].notch).toEqual({ joint_name: null, width_mm: null, depth_mm: null })
    expect(ps[0]).toMatchObject({ end_a: 'notch', end_b: 'notch' })
  })
  it('an entry without item_id gives item_id null', () => {
    const e = entry([line()]); delete e.item_id
    expect(piecesOf([e]).get('P|F')[0].item_id).toBeNull()
  })
  it('skips unresolved lines', () => {
    expect(piecesOf([entry([line({ resolved: false })])]).size).toBe(0)
  })
})

describe('packWithOffcuts', () => {
  it('uses a stock offcut of the profile before opening a new bar', () => {
    const r = packWithOffcuts([pc(2.0), pc(2.0), pc(2.0), pc(2.0)], 6.4, S, [{ id: 'o1', code: 'OC-0001', length_m: 2.1 }])
    expect(r.offcutBars).toHaveLength(1)
    expect(r.offcutBars[0].pieces).toHaveLength(1)
    expect(r.bars).toHaveLength(1)
    expect(r.bars[0].pieces).toHaveLength(3)
  })
  it('an offcut too short for every piece is left unused', () => {
    const r = packWithOffcuts([pc(1.5)], 6.4, S, [{ id: 'o1', code: 'OC-0001', length_m: 0.8 }])
    expect(r.offcutBars).toHaveLength(0)
  })
  it('the last piece on an offcut needs no trailing kerf', () => {
    const r = packWithOffcuts([pc(1.0)], 6.4, S, [{ id: 'o1', code: 'OC-0001', length_m: 1.0 }])
    expect(r.offcutBars).toHaveLength(1)
    expect(r.offcutBars[0].left_m).toBe(0)
  })
  it('a piece longer than the bar is unplaced, never dropped', () => {
    const r = packWithOffcuts([pc(7.0), pc(1.0)], 6.4, S, [])
    expect(r.unplaced.map(p => p.length_m)).toEqual([7.0])
    expect(r.bars).toHaveLength(1)
  })
  it('mitred pieces use the miter kerf', () => {
    const r = packWithOffcuts([pc(3.2, { kerf_style: 'miter45' }), pc(3.2, { kerf_style: 'miter45' })], 6.4, S, [])
    expect(r.bars).toHaveLength(2) // 3.2 + 0.010 + 3.2 > 6.4
  })
})

describe('groupIdenticalBars', () => {
  it('bars with the same pieces in the same order share one row', () => {
    const b = (lens) => ({ length_m: 6.4, left_m: 0, pieces: lens.map(l => pc(l)) })
    const g = groupIdenticalBars([b([2, 2]), b([2, 2]), b([1])])
    expect(g.map(x => [x.count, x.nos])).toEqual([[2, [1, 2]], [1, [3]]])
  })
})

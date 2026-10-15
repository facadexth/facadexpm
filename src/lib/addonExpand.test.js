import { describe, it, expect } from 'vitest'
import { expandAddons } from './addonExpand.js'
import { defaultAddonPieces, PIECE_LABEL } from './addonModel.js'

const MAIN = { widthMm: 1800, heightMm: 1200 }
const LONG = 'กล่องร่องวิ่งยาว'
const BUTT = { [LONG]: 50, DIV: 25 }
const buttOf = (f) => (f === 'NOBUTT' ? null : f in BUTT ? BUTT[f] : f ? 38.1 : null)
// Default rows (butt 38.1 ⇒ deductions 76.2) with every family filled in, unless `fams` says otherwise.
const rowsFor = (mode, kind, position, fams = {}) =>
  defaultAddonPieces({ mode, kind, position, layoutKind: 'sliding_2', buttMm: 38.1 })
    .map((r) => ({ ...r, profile_family: r.piece_key in fams ? fams[r.piece_key] : `P_${r.piece_key}` }))
const add = (o) => ({ mode: 'merge', kind: 'fixed', position: 'top', len_mm: 1800, thick_mm: 400, offset_mm: 0, rows: 1, cols: 3, ...o })
const run = (addons, pieceRows) => expandAddons({ addons, pieceRows, main: MAIN, buttOf, layoutKind: 'sliding_2' })
const of = (comps, key) => comps.filter((c) => c.role_name.startsWith(`${PIECE_LABEL[key]} (`))
const only = (comps, key) => { const r = of(comps, key); expect(r).toHaveLength(1); return r[0] }

describe('expandAddons — attach', () => {
  it('top 1800 × 400, 1 × 3', () => {
    const r = run([add({ mode: 'attach' })], rowsFor('attach', 'fixed', null))
    expect(r.issues).toEqual([])
    expect(r.attach).toHaveLength(1)
    const { addonIndex, opening, components } = r.attach[0]
    expect(addonIndex).toBe(0)
    expect(opening).toEqual({ width_m: 1.8, height_m: 0.4, panel_count: 3 })
    for (const k of ['frame_top', 'frame_bottom']) {
      const c = only(components, k)
      expect(c.fixed_length_mm).toBeCloseTo(1723.8, 6)
      expect(c.quantity_value).toBe(1)
    }
    expect(only(components, 'frame_side')).toMatchObject({ fixed_length_mm: 400, quantity_value: 2 })
    const m = only(components, 'mullion')
    expect(m.fixed_length_mm).toBeCloseTo(323.8, 6)
    expect(m.quantity_value).toBe(2)
    expect(of(components, 'rail')).toHaveLength(0)
    expect(r.glass).toHaveLength(1)
    expect(r.glass[0].addonIndex).toBe(0)
    expect(r.glass[0].count).toBe(3)
    expect(r.glass[0].widthMm).toBeCloseTo(574.6, 6)
    expect(r.glass[0].heightMm).toBeCloseTo(323.8, 6)
    expect(r.merge).toEqual({ overrides: {}, sideButt: {}, components: [], notes: [] })
  })

  it('component shape', () => {
    const c = only(run([add({ mode: 'attach' })], rowsFor('attach', 'fixed', null)).attach[0].components, 'frame_top')
    expect(c).toEqual({
      role_name: 'เฟรมบน (ช่องแสง 1)', profile_family: 'P_frame_top', length_rule_type: 'width', length_deduction_mm: 0,
      length_factor: 1, end_deduction_mm: 0, fixed_length_mm: c.fixed_length_mm, quantity_basis: 'fixed', quantity_value: 1,
      thickness_role: null, sort_order: 0, cut_style: 'square', addon_index: 0,
    })
  })

  it('right thick 500 len 1200, 2 × 2', () => {
    const r = run([add({ mode: 'attach', position: 'right', thick_mm: 500, len_mm: 1200, rows: 2, cols: 2 })], rowsFor('attach', 'fixed', null))
    const { components, opening } = r.attach[0]
    expect(opening).toEqual({ width_m: 0.5, height_m: 1.2, panel_count: 2 })
    expect(only(components, 'mullion').fixed_length_mm).toBeCloseTo(1123.8, 6)
    expect(only(components, 'mullion').quantity_value).toBe(1)
    expect(only(components, 'rail').fixed_length_mm).toBeCloseTo(423.8, 6)
    expect(only(components, 'rail').quantity_value).toBe(1)
    expect(r.glass[0].count).toBe(4)
    expect(r.glass[0].widthMm).toBeCloseTo(211.9, 6)
    expect(r.glass[0].heightMm).toBeCloseTo(561.9, 6)
  })

  it('an attach add-on never extends the main frame', () => {
    const r = run([add({ mode: 'attach' })], rowsFor('attach', 'fixed', null))
    expect(r.merge.overrides).toEqual({})
  })
})

describe('expandAddons — merge (sliding_2)', () => {
  it('top 1800 × 400, 1 × 3, ext family changed', () => {
    const r = run([add()], rowsFor('merge', 'fixed', 'top', { ext: LONG, main_facing: null }))
    expect(r.issues).toEqual([])
    expect(r.attach).toEqual([])
    const { overrides, sideButt, components, notes } = r.merge
    expect(overrides).toEqual({ frame_side: { lengthMm: 1600, family: LONG } })
    expect(overrides.frame_top).toBeUndefined()
    expect(sideButt).toEqual({})
    expect(notes).toEqual([{ addonIndex: 0, position: 'top', text: 'ตบเรียบ (รองคิ้วเท)' }])
    expect(of(components, 'divider')).toHaveLength(0)
    expect(of(components, 'ext')).toHaveLength(0)
    expect(of(components, 'main_facing')).toHaveLength(0)
    expect(only(components, 'ao_frame_side')).toMatchObject({ fixed_length_mm: 400, quantity_value: 2 })
    for (const k of ['ao_bead', 'ao_frame_far']) {
      expect(only(components, k).fixed_length_mm).toBeCloseTo(1723.8, 6)
      expect(only(components, k).quantity_value).toBe(1)
    }
    expect(only(components, 'mullion').fixed_length_mm).toBeCloseTo(323.8, 6)
    expect(only(components, 'mullion').quantity_value).toBe(2)
    expect(components.every((c) => c.addon_index === 0)).toBe(true)
    expect(components.map((c) => c.sort_order)).toEqual(components.map((_, i) => i))
    expect(r.glass[0]).toMatchObject({ addonIndex: 0, count: 3 })
    expect(r.glass[0].widthMm).toBeCloseTo(574.6, 6)
    expect(r.glass[0].heightMm).toBeCloseTo(323.8, 6)
  })

  it('bottom: no bead, note ตบร่อง', () => {
    const r = run([add({ position: 'bottom' })], rowsFor('merge', 'fixed', 'bottom'))
    expect(of(r.merge.components, 'ao_bead')).toHaveLength(0)
    expect(r.merge.notes).toEqual([{ addonIndex: 0, position: 'bottom', text: 'ตบร่อง' }])
  })

  it('main_facing family overrides the facing position; note shown in role names of other pieces', () => {
    const rows = rowsFor('merge', 'fixed', 'top', { ext: null, main_facing: 'MF' }).map((x) => (x.piece_key === 'ao_bead' ? { ...x, note: 'สีดำ' } : x))
    const r = run([add()], rows)
    expect(r.merge.overrides.frame_top).toEqual({ family: 'MF' })
    expect(r.merge.overrides.frame_side).toEqual({ lengthMm: 1600 })
    expect(only(r.merge.components, 'ao_bead').role_name).toBe(`${PIECE_LABEL.ao_bead} (ช่องแสง 1) [สีดำ]`)
  })

  it('left (spec path) thick 400 len 1200, divider butt 25', () => {
    const r = run([add({ position: 'left', len_mm: 1200, cols: 1 })], rowsFor('merge', 'fixed', 'left', { ext: null, divider: 'DIV', main_facing: null }))
    expect(r.issues).toEqual([])
    expect(r.merge.overrides.frame_top).toEqual({ lengthMm: 2200 })
    expect(r.merge.overrides.frame_bottom).toEqual({ lengthMm: 2200 })
    expect(r.merge.overrides.frame_side).toBeUndefined()
    const d = only(r.merge.components, 'divider')
    expect(d.fixed_length_mm).toBeCloseTo(1123.8, 6)
    expect(d.quantity_value).toBe(1)
    expect(r.merge.sideButt).toEqual({ left: 25 })
  })

  it('stacking: two top add-ons, top + bottom, top + left', () => {
    const top = rowsFor('merge', 'fixed', 'top')
    const both = [...top, ...rowsFor('merge', 'fixed', 'bottom'), ...rowsFor('merge', 'fixed', 'left', { divider: 'DIV' })]
    expect(run([add(), add({ thick_mm: 300 })], top).merge.overrides.frame_side.lengthMm).toBe(1900)
    expect(run([add(), add({ position: 'bottom' })], both).merge.overrides.frame_side.lengthMm).toBe(2000)
    const tl = run([add(), add({ position: 'left', len_mm: 1200 })], both).merge.overrides
    expect(tl.frame_side.lengthMm).toBe(1600)
    expect(tl.frame_top.lengthMm).toBe(2200)
    expect(tl.frame_bottom.lengthMm).toBe(2200)
  })

  it('ext families: first wins, a differing later one is addon_conflict', () => {
    const rows = rowsFor('merge', 'fixed', 'top', { ext: LONG })
    const r = run([add(), add({ position: 'bottom' })], [...rows, ...rowsFor('merge', 'fixed', 'bottom', { ext: 'OTHER' })])
    expect(r.merge.overrides.frame_side.family).toBe(LONG)
    expect(r.issues).toContainEqual({ role_name: `${PIECE_LABEL.ext} (ช่องแสง 2)`, reason: 'addon_conflict', addonIndex: 1 })
  })

  it('left + right main_facing with different families: first wins, addon_conflict', () => {
    const rows = [...rowsFor('merge', 'fixed', 'left', { main_facing: 'A' }), ...rowsFor('merge', 'fixed', 'right', { main_facing: 'B' })]
    const r = run([add({ position: 'left', len_mm: 1200 }), add({ position: 'right', len_mm: 1200 })], rows)
    expect(r.merge.overrides.frame_side).toEqual({ family: 'A' })
    expect(r.issues.filter((i) => i.reason === 'addon_conflict')).toHaveLength(1)
  })
})

describe('expandAddons — issues and edge cases', () => {
  it('family null on a qty > 0 piece ⇒ no_profile_family, no component', () => {
    const r = run([add({ mode: 'attach' })], rowsFor('attach', 'fixed', null, { frame_top: null }))
    expect(r.issues).toEqual([{ role_name: 'เฟรมบน (ช่องแสง 1)', reason: 'no_profile_family', addonIndex: 0 }])
    expect(of(r.attach[0].components, 'frame_top')).toHaveLength(0)
  })

  it('buttOf null ⇒ no_butt_distance, butt counted 0', () => {
    const r = run([add({ mode: 'attach' })], rowsFor('attach', 'fixed', null, { frame_side: 'NOBUTT' }))
    expect(r.issues).toEqual([{ role_name: 'เฟรมข้าง (ช่องแสง 1)', reason: 'no_butt_distance', addonIndex: 0 }])
    expect(r.glass[0].widthMm).toBeCloseTo(600, 6)
    expect(r.glass[0].heightMm).toBeCloseTo(400, 6)
    const d = run([add({ position: 'left', len_mm: 1200 })], rowsFor('merge', 'fixed', 'left', { divider: 'NOBUTT' }))
    expect(d.issues).toContainEqual({ role_name: `${PIECE_LABEL.divider} (ช่องแสง 1)`, reason: 'no_butt_distance', addonIndex: 0 })
    expect(d.merge.sideButt).toEqual({ left: 0 })
  })

  it('offset 1500 + len 1800 ⇒ addon_out_of_range, still expanded', () => {
    const r = run([add({ mode: 'attach', offset_mm: 1500 })], rowsFor('attach', 'fixed', null))
    expect(r.issues).toEqual([{ role_name: 'ช่องแสง 1', reason: 'addon_out_of_range', addonIndex: 0 }])
    expect(r.attach[0].components.length).toBeGreaterThan(0)
  })

  it('thick ≤ 0 ⇒ addon_out_of_range', () => {
    const r = run([add({ mode: 'attach', thick_mm: 0 })], rowsFor('attach', 'fixed', null))
    expect(r.issues).toContainEqual({ role_name: 'ช่องแสง 1', reason: 'addon_out_of_range', addonIndex: 0 })
  })

  it('thick 50 with ded 76.2 on a vertical piece ⇒ addon_piece_too_small, component dropped', () => {
    const r = run([add({ mode: 'attach', thick_mm: 50 })], rowsFor('attach', 'fixed', null))
    expect(r.issues).toEqual([{ role_name: 'ซอยกลางตั้ง (ช่องแสง 1)', reason: 'addon_piece_too_small', addonIndex: 0 }])
    expect(of(r.attach[0].components, 'mullion')).toHaveLength(0)
    expect(of(r.attach[0].components, 'frame_side')).toHaveLength(1)
  })

  it('null / empty input ⇒ empty shape; never throws', () => {
    const empty = { attach: [], merge: { overrides: {}, sideButt: {}, components: [], notes: [] }, glass: [], issues: [] }
    expect(expandAddons(null)).toEqual(empty)
    expect(expandAddons(undefined)).toEqual(empty)
    expect(expandAddons({ addons: [], pieceRows: null, main: MAIN, buttOf })).toEqual(empty)
    expect(() => expandAddons({ addons: [null, 'x', {}], pieceRows: 'bad', main: null, buttOf: null })).not.toThrow()
  })

  it('frozen inputs are not mutated', () => {
    const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o) }
    const addons = deepFreeze([add(), add({ mode: 'attach', position: 'bottom' })])
    const rows = deepFreeze([...rowsFor('merge', 'fixed', 'top'), ...rowsFor('attach', 'fixed', null)])
    const main = deepFreeze({ ...MAIN })
    const before = JSON.stringify([addons, rows, main])
    expect(() => expandAddons({ addons, pieceRows: rows, main, buttOf, layoutKind: 'sliding_2' })).not.toThrow()
    expect(JSON.stringify([addons, rows, main])).toBe(before)
  })

  it('no rows for the set ⇒ defaults used (families null ⇒ issues)', () => {
    const r = run([add()], rowsFor('merge', 'fixed', 'bottom'))   // rows of another set only
    const defaults = defaultAddonPieces({ mode: 'merge', kind: 'fixed', position: 'top', layoutKind: 'sliding_2' })
    const a = add()
    const expected = defaults.filter((d) => !['ext', 'main_facing'].includes(d.piece_key))
      .filter((d) => (d.qty_rule === 'fixed' ? d.qty_fixed : d.qty_rule === 'cols-1' ? a.cols - 1 : a.rows - 1) > 0)
    expect(r.issues.map((i) => i.reason)).toEqual(expected.map(() => 'no_profile_family'))
    expect(r.issues.map((i) => i.role_name)).toEqual(expected.map((d) => `${PIECE_LABEL[d.piece_key]} (ช่องแสง 1)`))
    expect(r.merge.components).toEqual([])
    expect(r.merge.overrides).toEqual({ frame_side: { lengthMm: 1600 } })
    expect(r.merge.notes).toEqual([{ addonIndex: 0, position: 'top', text: 'ตบเรียบ (รองคิ้วเท)' }])
  })
})

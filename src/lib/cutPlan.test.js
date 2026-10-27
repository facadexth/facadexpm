// src/lib/cutPlan.test.js
import { describe, it, expect } from 'vitest'
import { piecesOf, packWithOffcuts, groupIdenticalBars, rangeLengths, evaluateLength, bestLength, chooseLengths, planSignature, buildCutPlan, issuePayload } from './cutPlan.js'

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

const S2 = { ...S, stock_length_m: 6.4, custom_len_min_m: 4, custom_len_max_m: 7, custom_len_step_m: 0.05, custom_moq_kg: 1000 }

describe('groupIdenticalBars keeps different items and notch sizes apart', () => {
  const nb = (o) => ({ length_m: 6.4, left_m: 0, pieces: [pc(2, { end_a: 'notch', notch: { joint_name: 'j', width_mm: 20, depth_mm: 8 }, item_id: 'i1', ...o })] })
  it('two bars differing only in notch width are separate rows', () => {
    const g = groupIdenticalBars([nb(), nb({ notch: { joint_name: 'j', width_mm: 25, depth_mm: 8 } })])
    expect(g.map(x => x.count)).toEqual([1, 1])
  })
  it('two bars differing only in notch depth are separate rows', () => {
    const g = groupIdenticalBars([nb(), nb({ notch: { joint_name: 'j', width_mm: 20, depth_mm: 10 } })])
    expect(g.map(x => x.count)).toEqual([1, 1])
  })
  it('two bars differing only in item are separate rows', () => {
    const g = groupIdenticalBars([nb(), nb({ item_id: 'i2' })])
    expect(g.map(x => x.count)).toEqual([1, 1])
  })
  it('identical notched bars still share one row', () => {
    expect(groupIdenticalBars([nb(), nb()]).map(x => x.count)).toEqual([2])
  })
})

describe('rangeLengths', () => {
  it('4.00..7.00 by 0.05 is 61 values', () => {
    const r = rangeLengths(S2)
    expect(r).toHaveLength(61); expect(r[0]).toBe(4); expect(r[60]).toBe(7)
  })
  it('an invalid range gives no candidates', () => { expect(rangeLengths({ ...S2, custom_len_step_m: 0 })).toEqual([]) })
})

describe('evaluateLength', () => {
  it('counts kg for new bars only and splits remainders into keep and scrap', () => {
    const ev = evaluateLength([pc(2.0), pc(2.0), pc(2.0)], 6.4, S2, [], 0.5)
    expect(ev.newBars).toBe(1); expect(ev.kg).toBeCloseTo(3.2, 9); expect(ev.feasible).toBe(true)
    expect(ev.scrap_m).toBeCloseTo(0.391, 9); expect(ev.keep_m).toBe(0)
  })
})

describe('bestLength', () => {
  it('picks the length that buys the least kg', () => {
    const pieces = Array.from({ length: 8 }, () => pc(2.4))   // 2 per 4.85 m bar
    const b = bestLength(pieces, [6.4, 4.85], S2, [], 0.62)
    expect(b.length_m).toBe(4.85)
  })
  it('never picks an infeasible length', () => {
    expect(bestLength([pc(5.0)], [4.0, 4.5], S2, [], 1)).toBe(null)
  })
})

describe('chooseLengths', () => {
  const groups = [{ key: 'A|F', pieces: Array.from({ length: 8 }, () => pc(2.4)) }]
  it('stock mode always uses the stock length', () => {
    const r = chooseLengths({ groups, mode: 'stock', settings: S2, kgPerM: { 'A|F': 0.62 }, offcutsByGroup: {}, overrides: {} })
    expect(r.byGroup['A|F'].length_m).toBe(6.4)
  })
  it('custom mode below the minimum order falls back to stock and says why', () => {
    const r = chooseLengths({ groups, mode: 'custom', settings: S2, kgPerM: { 'A|F': 0.62 }, offcutsByGroup: {}, overrides: {} })
    expect(r.moqMet).toBe(false); expect(r.reason).toBe('moq'); expect(r.byGroup['A|F'].length_m).toBe(6.4)
  })
  it('custom mode at or above the minimum keeps the custom lengths', () => {
    const big = [{ key: 'A|F', pieces: Array.from({ length: 800 }, () => pc(2.4)) }]
    const r = chooseLengths({ groups: big, mode: 'custom', settings: S2, kgPerM: { 'A|F': 0.62 }, offcutsByGroup: {}, overrides: {} })
    expect(r.moqMet).toBe(true); expect(r.byGroup['A|F'].custom).toBe(true)
  })
})

describe('buildCutPlan', () => {
  const entries = [entry([line({ length_m: 2.0, quantity: 3 })])]
  const groupInfo = { 'P|F': { profile_id: 'P', finish_id: 'F', die_no: 'F7976', name: 'เฟรม', finish_name: 'ขาว' } }
  it('lists remainders as new offcuts with a keep default from min_keep_offcut_m', () => {
    const plan = buildCutPlan({ entries, mode: 'stock', settings: S2, kgPerM: { 'P|F': 0.5 }, offcutsByGroup: {}, overrides: {}, groupInfo })
    const g = plan.groups[0]
    expect(g.bars).toHaveLength(1)
    expect(g.newOffcuts).toEqual([{ key: 'P|F#1', bar_ref: '1', length_m: 0.391, end_a: 'square', keep: false }])
  })
  it('the signature changes when an item changes and not otherwise', () => {
    expect(planSignature(entries)).toBe(planSignature([entry([line({ length_m: 2.0, quantity: 3 })])]))
    expect(planSignature(entries)).not.toBe(planSignature([entry([line({ length_m: 2.1, quantity: 3 })])]))
  })
  it('issuePayload sends the used stock offcut ids and only the kept new offcuts', () => {
    // offcut 2.05: first 2.0 piece goes on it (0.047 left = saw loss, no offcut); two pieces on a new bar leave 2.394 (kept by default)
    const plan = buildCutPlan({ entries, mode: 'stock', settings: S2, kgPerM: { 'P|F': 0.5 }, offcutsByGroup: { 'P|F': [{ id: 'o1', code: 'OC-0001', length_m: 2.05 }] }, overrides: {}, groupInfo })
    const kept = issuePayload(plan, new Set())
    expect(kept.p_used_offcut_ids).toEqual(['o1'])
    expect(kept.p_new_offcuts).toEqual([{ key: 'P|F#1', profile_id: 'P', finish_id: 'F', length_m: 2.394, end_a: 'square' }])
    expect(issuePayload(plan, new Set(['P|F#1'])).p_new_offcuts).toEqual([])
  })
  it('flipping a dropped remainder creates it', () => {
    const plan = buildCutPlan({ entries, mode: 'stock', settings: S2, kgPerM: { 'P|F': 0.5 }, offcutsByGroup: {}, overrides: {}, groupInfo })
    expect(issuePayload(plan, new Set()).p_new_offcuts).toEqual([])
    expect(issuePayload(plan, new Set(['P|F#1'])).p_new_offcuts).toEqual([{ key: 'P|F#1', profile_id: 'P', finish_id: 'F', length_m: 0.391, end_a: 'square' }])
  })
  it('a stock offcut of another finish is never used', () => {
    const plan = buildCutPlan({ entries, mode: 'stock', settings: S2, kgPerM: { 'P|F': 0.5 }, offcutsByGroup: { 'P|G': [{ id: 'o9', code: 'OC-0009', length_m: 2.05 }] }, overrides: {}, groupInfo })
    expect(plan.groups[0].offcutBars).toEqual([])
    expect(issuePayload(plan, new Set()).p_used_offcut_ids).toEqual([])
  })
})

describe('fix round 1', () => {
  const eight = () => [{ key: 'A|F', pieces: Array.from({ length: 8 }, () => pc(2.4)) }]
  it('custom mode with no kg/m stays on stock and is marked no_weight', () => {
    const r = chooseLengths({ groups: eight(), mode: 'custom', settings: S2, kgPerM: {}, offcutsByGroup: {}, overrides: {} })
    expect(r.byGroup['A|F']).toMatchObject({ length_m: 6.4, custom: false, no_weight: true })
    expect(r.customKg).toBe(0)
  })
  it('mixed: a weighted 1 t group stays custom, an unweighted group stays stock with no_weight', () => {
    const groups = [{ key: 'A|F', pieces: Array.from({ length: 800 }, () => pc(2.4)) }, { key: 'B|F', pieces: Array.from({ length: 8 }, () => pc(2.4)) }]
    const r = chooseLengths({ groups, mode: 'custom', settings: S2, kgPerM: { 'A|F': 0.62, 'B|F': 0 }, offcutsByGroup: {}, overrides: {} })
    expect(r.moqMet).toBe(true)
    expect(r.byGroup['A|F']).toMatchObject({ length_m: 4.85, custom: true })
    expect(r.byGroup['A|F'].no_weight).toBeUndefined()
    expect(r.byGroup['B|F']).toMatchObject({ length_m: 6.4, custom: false, no_weight: true })
    expect(r.customKg).toBeCloseTo(400 * 4.85 * 0.62, 6)
  })
  it('a stock length given as text is read as a number', () => {
    const r = chooseLengths({ groups: eight(), mode: 'stock', settings: { ...S2, stock_length_m: '6.4' }, kgPerM: { 'A|F': 0.62 }, offcutsByGroup: {}, overrides: {} })
    expect(r.byGroup['A|F'].length_m).toBe(6.4)
    expect(r.byGroup['A|F'].eval.newBars).toBe(4)
  })
  it('an infeasible override is rejected and flagged; a feasible one is not', () => {
    const big = [{ key: 'A|F', pieces: Array.from({ length: 800 }, () => pc(2.4)) }]
    const bad = chooseLengths({ groups: big, mode: 'custom', settings: S2, kgPerM: { 'A|F': 0.62 }, offcutsByGroup: {}, overrides: { 'A|F': 2.0 } })
    expect(bad.byGroup['A|F']).toMatchObject({ length_m: 4.85, overrideRejected: true })
    const ok = chooseLengths({ groups: big, mode: 'custom', settings: S2, kgPerM: { 'A|F': 0.62 }, offcutsByGroup: {}, overrides: { 'A|F': 5.0 } })
    expect(ok.byGroup['A|F']).toMatchObject({ length_m: 5.0, overrideRejected: false })
  })
  it('a notch-width-only change changes the plan signature; identical entries do not', () => {
    const n = (w) => [entry([line({ cut_style: 'notch', cut_ends: 2, joint_name: 'j', notch_width_mm: w, notch_depth_mm: 8 })])]
    expect(planSignature(n(20))).toBe(planSignature(n(20)))
    expect(planSignature(n(20))).not.toBe(planSignature(n(25)))
  })
  it('an item-only change changes the plan signature', () => {
    expect(planSignature([entry([line()])])).not.toBe(planSignature([entry([line()], { item_id: 'i2' })]))
  })
  it('a remainder after a notched end starts square', () => {
    const entries = [entry([line({ length_m: 2.0, quantity: 3, cut_style: 'notch', cut_ends: 2, notch_width_mm: 20, notch_depth_mm: 8 })])]
    const plan = buildCutPlan({ entries, mode: 'stock', settings: S2, kgPerM: { 'P|F': 0.5 }, offcutsByGroup: {}, overrides: {}, groupInfo: {} })
    expect(plan.groups[0].bars[0].pieces[2].end_b).toBe('notch')
    expect(plan.groups[0].newOffcuts[0]).toMatchObject({ length_m: 0.391, end_a: 'square' })
  })
  it('a remainder after a mitred end keeps the mitre', () => {
    const entries = [entry([line({ length_m: 2.0, quantity: 2, cut_style: 'miter45', cut_ends: 2 })])]
    const plan = buildCutPlan({ entries, mode: 'stock', settings: S2, kgPerM: { 'P|F': 0.5 }, offcutsByGroup: {}, overrides: {}, groupInfo: {} })
    expect(plan.groups[0].newOffcuts[0]).toMatchObject({ length_m: 2.38, end_a: 'miter45' })
  })
})

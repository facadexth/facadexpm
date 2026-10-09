import { describe, it, expect } from 'vitest'
import { mergeSettings } from './estimationSettings.js'
import { buildProjectBom, stockLengthFor, stockForProject } from './projectBom.js'

const S = mergeSettings(null)
const pl = (o = {}) => ({ role_name: 'r', profile_id: 'p1', length_m: 2, quantity: 2, resolved: true, cut_style: 'square', ...o })
const bom = (profileLines, extra = {}) => ({ profileLines, gridLines: [], hardwareLines: [], hardwareSetLines: [], unresolvedDetails: [], ...extra })
const profilesById = { p1: { id: 'p1', name: 'กล่องเรียบ', drawing_no: 'U1613' }, p2: { id: 'p2', name: 'ตัวแบ่ง' } }
const finishesById = { f1: { id: 'f1', name: 'อบขาว' } }
const run = (entries, stock) => buildProjectBom({ entries, settings: S, stock, profilesById, finishesById })

describe('stockLengthFor', () => {
  it('per-profile override > project > tenant default', () => {
    expect(stockLengthFor('p1', { byProfile: { p1: 6 }, projectM: 5.8 }, S)).toBe(6)
    expect(stockLengthFor('p2', { byProfile: { p1: 6 }, projectM: 5.8 }, S)).toBe(5.8)
    expect(stockLengthFor('p2', null, S)).toBe(6.4)
    expect(stockLengthFor('p2', { byProfile: { p2: 0 }, projectM: 'x' }, S)).toBe(6.4)
  })
})

describe('buildProjectBom', () => {
  it('multiplies by the item quantity and merges equal cuts of one profile + colour across items', () => {
    const r = run([
      { opening_no: 'D1', quantity: 3, finish_id: 'f1', bom: bom([pl()]) },
      { opening_no: 'D2', quantity: 1, finish_id: 'f1', bom: bom([pl({ quantity: 4 })]) },
    ])
    expect(r.profiles).toHaveLength(1)
    expect(r.profiles[0].cuts).toEqual([{ length_m: 2, style: 'square', quantity: 10 }])
    expect(r.profiles[0]).toMatchObject({ name: 'กล่องเรียบ', die_no: 'U1613', finish_name: 'อบขาว', cut_total_m: 20, stock_length_m: 6.4, count: 4 })
    expect(r.profiles[0].openings.sort()).toEqual(['D1', 'D2'])
  })
  it('the same profile in two colours is two rows; a 45 degree cut is kept apart from a square cut', () => {
    const r = run([
      { opening_no: 'D1', quantity: 1, finish_id: 'f1', bom: bom([pl(), pl({ cut_style: 'miter45' })]) },
      { opening_no: 'D2', quantity: 1, finish_id: 'f2', bom: bom([pl()]) },
    ])
    expect(r.profiles).toHaveLength(2)
    expect(r.profiles.find(p => p.finish_id === 'f1').cuts.map(c => c.style).sort()).toEqual(['miter45', 'square'])
  })
  it('an unresolved line is listed with its opening and reason, never counted as aluminium', () => {
    const r = run([{ opening_no: 'D1', quantity: 1, finish_id: 'f1', bom: bom([pl({ resolved: false, profile_id: undefined, role_name: 'วงกบ', reason: 'no_profile' })]) }])
    expect(r.profiles).toEqual([])
    expect(r.unresolved).toEqual([{ opening_no: 'D1', name: 'วงกบ', reason: 'no_profile' }])
  })
  it('the add-on BOM is rolled up too', () => {
    const r = run([{ opening_no: 'D1', quantity: 2, finish_id: 'f1', bom: bom([pl({ quantity: 1 })]), addonBom: bom([pl({ profile_id: 'p2', quantity: 1, length_m: 1 })]) }])
    expect(r.profiles.map(p => p.name).sort()).toEqual(['กล่องเรียบ', 'ตัวแบ่ง'])
  })
  it('hardware, set lines and accessories merge by part with summed quantity and cost; one unresolved part marks the row', () => {
    const hw = { hardwareLines: [{ name: 'ล้อ', quantity: 2, cost: 20, unresolved: false }], hardwareSetLines: [{ code: 'P-1', name: 'ชุด A', quantity: 1, cost: 100, resolved: true }] }
    const extras = { lines: [{ key: 'shim', part_id: 'ps', name: 'shim', quantity: 20, cost: 40, resolved: true }], sealant_m: 9 }
    const r = run([
      { opening_no: 'D1', quantity: 2, finish_id: 'f1', bom: bom([], hw), extras },
      { opening_no: 'D2', quantity: 1, finish_id: 'f1', bom: bom([], { ...hw, hardwareLines: [{ name: 'ล้อ', quantity: 2, cost: 0, unresolved: true }] }), extras },
    ])
    const wheel = r.parts.find(p => p.name === 'ล้อ')
    expect(wheel).toMatchObject({ quantity: 6, cost: 40, resolved: false, kind: 'hardware' })
    expect(r.parts.find(p => p.code === 'P-1')).toMatchObject({ quantity: 3, cost: 300 })
    expect(r.parts.find(p => p.name === 'shim')).toMatchObject({ quantity: 60, cost: 120, kind: 'accessory' })
  })
  it('sealant is one total length rounded up to tubes (27 m at 10 m per tube = 3)', () => {
    const r = run([{ opening_no: 'D1', quantity: 3, finish_id: 'f1', bom: bom([]), extras: { lines: [], sealant_m: 9 } }])
    expect(r.sealant).toEqual({ length_m: 27, tubes: 3, m_per_tube: 10 })
  })
  it('a missing or zero quantity counts as 1; no entries is an empty BOM', () => {
    const r = run([{ opening_no: 'D1', quantity: 0, finish_id: 'f1', bom: bom([pl({ quantity: 1 })]) }])
    expect(r.profiles[0].cut_total_m).toBe(2)
    expect(run([])).toMatchObject({ profiles: [], parts: [], unresolved: [], sealant: { tubes: 0 } })
  })
})

describe('costOpening problems surface in the project BOM', () => {
  it('joint issues, no_dimension, unknown infill and add-on problems are listed with the opening; profile-line problems are not doubled', () => {
    const unresolved = [
      { name: 'bar', reason: 'no_main_profile', source: 'joint' },
      { name: 'ขนาดช่องเปิด', reason: 'no_dimension', source: 'main' },
      { name: 'วัสดุอุดช่อง', reason: 'unknown_infill', source: 'main' },
      { name: 'ชุดต่อเติม', reason: 'unknown_addon_template', source: 'addon' },
      { name: 'ชุดต่อเติม', reason: 'no_dimension', source: 'addon' },
      { name: 'วงกบ', reason: 'no_profile', source: 'main' },
      { name: 'ล้อ', reason: 'no_hardware_price', source: 'main' },
    ]
    const r = run([{ opening_no: 'D1', quantity: 1, finish_id: 'f1', bom: bom([pl({ resolved: false, profile_id: undefined, role_name: 'วงกบ', reason: 'no_profile' })]), unresolved }])
    expect(r.unresolved).toEqual([
      { opening_no: 'D1', name: 'วงกบ', reason: 'no_profile' },
      { opening_no: 'D1', name: 'bar', reason: 'no_main_profile' },
      { opening_no: 'D1', name: 'ขนาดช่องเปิด', reason: 'no_dimension' },
      { opening_no: 'D1', name: 'วัสดุอุดช่อง', reason: 'unknown_infill' },
      { opening_no: 'D1', name: 'ชุดต่อเติม', reason: 'unknown_addon_template' },
      { opening_no: 'D1', name: 'ชุดต่อเติม', reason: 'no_dimension' },
    ])
  })
})

describe('hardware merged by part_id', () => {
  it('two lines with the same part_id merge even if the names differ; a part marked accessory in partsById is tagged', () => {
    const hw = n => ({ hardwareLines: [{ name: n, part_id: 'ps1', quantity: 1, cost: 10, unresolved: false }, { name: 'ไม่มีรหัส', quantity: 1, cost: 5, unresolved: false }] })
    const r = buildProjectBom({ entries: [{ opening_no: 'D1', quantity: 1, bom: bom([], hw('ล้อ A')) }, { opening_no: 'D2', quantity: 1, bom: bom([], hw('ล้อ B')) }], settings: S, partsById: { ps1: { kind: 'accessory' } } })
    expect(r.parts).toHaveLength(2)
    expect(r.parts.find(p => p.key === 'ps1')).toMatchObject({ quantity: 2, cost: 20, kind: 'accessory' })
    expect(r.parts.find(p => p.name === 'ไม่มีรหัส')).toMatchObject({ quantity: 2, kind: 'hardware' })
  })
})

describe('stockForProject', () => {
  it('keeps only this project\'s per-profile lengths and its own default length', () => {
    const rows = [{ project_id: 'a', profile_id: 'p1', length_m: '5.8' }, { project_id: 'b', profile_id: 'p1', length_m: '9' }, { project_id: 'a', profile_id: 'p2', length_m: 6 }]
    expect(stockForProject(rows, 'a', { stock_length_m: '6.2' })).toEqual({ byProfile: { p1: 5.8, p2: 6 }, projectM: 6.2 })
    expect(stockForProject(null, 'a', null)).toEqual({ byProfile: {}, projectM: null })
  })
})

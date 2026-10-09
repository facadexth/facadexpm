import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { mergeSettings } from '../../lib/estimationSettings.js'
import {
  emptyQuick, quickTemplateGroups, quickSeriesOptions, quickFinishOptions, quickThicknessOptions, quickShowSash,
  reconcileQuick, quickMissing, buildQuickItem, quickCosts, quickView, quickOk,
} from './quickQuote.js'
import { changesView, refreshWarning, refreshPatch } from './staleView.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'โรงรีด A', price_basis: 'per_kg' }, { id: 'B', name: 'โรงรีด B', price_basis: 'per_kg' }],
  series: [{ id: 'sA', provider_id: 'A', name: 'Demo 40' }, { id: 'sB', provider_id: 'B', name: 'Demo 50' }, { id: 'sX', provider_id: 'B', name: 'Off', active: false }],
  types: [{ id: 'win', name: 'หน้าต่าง' }, { id: 'slide', name: 'บานเลื่อน', parent_id: 'win' }, { id: 'fixed', name: 'บานติดตาย', parent_id: 'win' }],
  seriesTypes: [{ series_id: 'sA', type_id: 'slide', allow_mixed_thickness: true }, { series_id: 'sB', type_id: 'fixed' }],
  finishes: [{ id: 'fA', provider_id: 'A', name: 'ขาว' }, { id: 'fB', provider_id: 'B', name: 'ดำ' }],
  profiles: [
    { id: 'p14', provider_id: 'A', family: 'frame', thickness_mm: 1.4, width_mm: 44, linear_weight_kg_per_m: 1 },
    { id: 'p16', provider_id: 'A', family: 'frame', thickness_mm: 1.6, width_mm: 44, linear_weight_kg_per_m: 1 },
    { id: 'pB', provider_id: 'B', family: 'frame', thickness_mm: 2, width_mm: 44, linear_weight_kg_per_m: 1 },
  ],
  seriesProfiles: [{ series_id: 'sA', profile_id: 'p14' }, { series_id: 'sA', profile_id: 'p16' }, { series_id: 'sB', profile_id: 'pB' }],
})
const c0 = { waste_pct: 5, labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 }
const tS = { id: 'tS', name: 'เลื่อน 2 บาน', type_id: 'slide', active: true, grid_row_weights: [1], main_axis: 'horizontal', preview_kind: 'slide', ...c0 }
const tOff = { id: 'tOff', name: 'ปิด', type_id: 'slide', active: false, ...c0 }
const ctx = {
  templatesById: { tS }, componentsByTemplate: { tS: [{ role_name: 'บน', profile_family: 'frame', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }] },
  hardwareByTemplate: {}, jointsByTemplate: {}, typesById: index.types, infillTypesById: {}, index, settings: mergeSettings(null), packageItems: null,
}
const project = { id: 'p1', default_series_id: 'sB', default_finish_id: 'fB', default_thickness_mm: '2', price_as_of: '2026-10-01' }

describe('quick calculator choices', () => {
  it('groups active templates under leaf types, skipping empty types', () => {
    expect(quickTemplateGroups(index, [tS, tOff])).toEqual([{ label: 'หน้าต่าง › บานเลื่อน', options: [{ value: 'tS', label: 'เลื่อน 2 บาน' }] }])
  })
  it('lists every active series as "series · extruder" and the colours of the series extruder', () => {
    expect(quickSeriesOptions(index).map(o => o.label).sort()).toEqual(['Demo 40 · โรงรีด A', 'Demo 50 · โรงรีด B'])
    expect(quickFinishOptions(index, 'sA').map(o => o.label)).toEqual(['ขาว'])
    expect(quickFinishOptions(index, '')).toEqual([])
  })
  it('shows the sash only where mixed thickness is allowed and never offers an "equal to frame" choice', () => {
    expect(quickShowSash(index, 'sA', tS)).toBe(true)
    expect(quickShowSash(index, 'sB', tS)).toBe(false)
    expect(quickThicknessOptions(index, 'sA').map(o => o.value)).toEqual(['1.4', '1.6'])
  })
  it('reconcile: drops a colour of another extruder, fills a single thickness, fills a shown sash with a real number', () => {
    const prev = { ...emptyQuick(), template_id: 'tS', series_id: 'sA', alu_finish_id: 'fA', thickness_mm: '1.4', sash_thickness_mm: '1.4' }
    const swapped = reconcileQuick(prev, { ...prev, series_id: 'sB' }, { index, template: tS })
    expect(swapped.alu_finish_id).toBe('')
    expect(swapped.thickness_mm).toBe('2')
    expect(swapped.sash_thickness_mm).toBe('')
    const framed = reconcileQuick({ ...prev, sash_thickness_mm: '' }, { ...prev, sash_thickness_mm: '', thickness_mm: '1.6' }, { index, template: tS })
    expect(framed.sash_thickness_mm).toBe('1.6')
  })
  it('says what is missing before a price can be shown', () => {
    expect(quickMissing(emptyQuick(), null, false)).toBe('เลือกเทมเพลต')
    const q = { ...emptyQuick(), template_id: 'tS', series_id: 'sA', alu_finish_id: 'fA', thickness_mm: '1.4', sash_thickness_mm: '', width_m: '1000', height_m: '1000' }
    expect(quickMissing(q, tS, true)).toBe('เลือกความหนากรอบบาน')
    expect(quickMissing({ ...q, sash_thickness_mm: '1.4' }, tS, true)).toBeNull()
    expect(quickMissing({ ...q, width_m: '' }, tS, false)).toBe('กรอกกว้างและสูง (มม.)')
  })
})

describe('throw-away item', () => {
  const q = { ...emptyQuick(), template_id: 'tS', series_id: 'sA', alu_finish_id: 'fA', thickness_mm: '1.4', sash_thickness_mm: '1.4', width_m: '1150', height_m: '1200', panel_count: '2' }
  it('is a plain object in metres that inherits hardware, infill, labour and profit from the project', () => {
    const it = buildQuickItem(q)
    expect(Object.getPrototypeOf(it)).toBe(Object.prototype)
    expect(JSON.parse(JSON.stringify(it))).toEqual(it)
    expect(it).toMatchObject({ width_m: 1.15, height_m: 1.2, panel_count: 2, series_id: 'sA', alu_finish_id: 'fA', thickness_mm: 1.4, template_id: 'tS' })
    expect(it).toMatchObject({ hardware_set_id: null, no_hardware_set: false, infill_type_id: null, no_infill: false, labour_per_sqm: null, profit_pct: null, addon_template_id: null })
  })
  it('costs at the project date and, only when different, at today; unresolved is never a number total of 0', () => {
    const two = quickCosts({ q, template: tS, project, ctx, today: '2026-10-09' })
    expect(two.map(r => [r.key, r.asOf])).toEqual([['project', '2026-10-01'], ['today', '2026-10-09']])
    for (const r of two) { expect(r.cost.unresolved.length).toBeGreaterThan(0); expect(r.cost.unresolved.some(u => u.source === 'main' && typeof u.reason === 'string' && u.reason.length > 0 && u.name)).toBe(true); expect(quickOk(r.cost)).toBe(false) }
    expect(quickCosts({ q, template: tS, project, ctx, today: '2026-10-01' })).toHaveLength(1)
  })
  it('the component imports no Supabase path', () => {
    const src = readFileSync(new URL('./QuickQuote.jsx', import.meta.url), 'utf8') + readFileSync(new URL('./quickQuote.js', import.meta.url), 'utf8')
    const imports = src.split('\n').filter(l => /^\s*(import|from)\b|^\} from/.test(l)).join('\n')
    expect(imports).not.toMatch(/supabase|useSupabase|hooks\//i)
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/)
    for (const f of ['ItemFields.jsx', 'projectDefaults.js', '../../lib/openingPayload.js']) {
      const t = readFileSync(new URL('./' + f, import.meta.url), 'utf8')
      expect(t, f).not.toMatch(/\.(insert|update|upsert|delete)\(/)
      expect(t.split('\n').filter(l => /^\s*import\b/.test(l)).join('\n'), f).not.toMatch(/supabase/i)
    }
  })
})

describe('refresh dialog view-model', () => {
  const changes = [{ opening_id: 'a', name: 'Top rail', before: null, after: null }, { opening_id: 'a', name: 'Side', before: null, after: null }, { opening_id: 'zz', name: 'X', before: null, after: null }]
  it('counts distinct items and names them', () => {
    const v = changesView(changes, { a: { opening_no: 'W1', item_name: 'ห้องนอน' } }, index)
    expect(v.itemCount).toBe(2)
    expect(v.rows.map(r => r.item)).toEqual(['W1 · ห้องนอน', 'W1 · ห้องนอน', 'zz'])
    expect(v.rows[0]).toHaveProperty('before')
    expect(v.rows[0]).toHaveProperty('after')
  })
  it('warns that ALL items are re-priced and writes only the price date', () => {
    expect(refreshWarning('2026-10-01', '2026-10-09')).toMatch(/ทุกรายการ/)
    expect(refreshPatch(new Date(2026, 9, 9, 12))).toEqual({ price_as_of: '2026-10-09' })
  })
})

describe('quick view: series types and hardware', () => {
  const q = { ...emptyQuick(), template_id: 'tS', series_id: 'sB', alu_finish_id: 'fB', thickness_mm: '2', width_m: '1000', height_m: '1000' }
  const st = [{ series_id: 'sA', type_id: 'slide' }, { series_id: 'sB', type_id: 'fixed' }]
  const qA = { ...q, series_id: 'sA', alu_finish_id: 'fA', thickness_mm: '1.4', sash_thickness_mm: '1.4' }
  const view = (over = {}, c = ctx) => quickView({ q, template: tS, project, ctx: c, today: '2026-10-09', seriesTypes: st, ...over })
  it('suppresses the price and names the series that build the type when not offered', () => {
    const v = view()
    expect(v.availability).toBe('not_offered')
    expect(v.results).toEqual([])
    expect(v.offeredBy).toEqual(['Demo 40'])
  })
  it('prices when offered, and unknown (no series types) behaves as before', () => {
    const ok = view({ q: qA })
    expect(ok.availability).toBe('ok')
    expect(ok.results.length).toBe(2)
    expect(view({ q: { ...qA, series_id: '' }, template: { ...tS, type_id: null } }).availability).toBe('unknown')
  })
  it('hardware: set / none / missing / no package', () => {
    const withIdx = pk => ({ ...ctx, packageItems: pk, index: { ...index, parts: { hw1: { id: 'hw1', name: 'ชุดเลื่อน' } } } })
    const set = view({ q: qA }, withIdx([{ type_id: 'slide', hardware_set_id: 'hw1' }]))
    expect(set.hardware.label).toBe('ชุดเลื่อน'); expect(set.hardwareWarning).toBeNull()
    const none = view({ q: qA }, withIdx([{ type_id: 'slide', hardware_set_id: null }]))
    expect(none.hardware.label).toBe('ไม่ใช้ชุดอุปกรณ์'); expect(none.hardwareWarning).toBeNull()
    const miss = view({ q: qA }, withIdx([{ type_id: 'fixed', hardware_set_id: 'hw1' }]))
    expect(miss.hardwareWarning).toBe('ประเภทนี้ยังไม่ได้กำหนดชุดในโปรเจกต์ ราคาไม่รวมชุดอุปกรณ์')
  })
  it('an unresolved cost is never an ok total', () => {
    const r = view({ q: qA }).results[0]
    expect(quickOk(r.cost)).toBe(false)
    expect(quickOk({ unresolved: [], total: 0 / 0 })).toBe(false)
    expect(quickOk({ unresolved: [], total: 12 })).toBe(true)
  })
})

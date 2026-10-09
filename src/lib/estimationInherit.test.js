// src/lib/estimationInherit.test.js
import { describe, it, expect } from 'vitest'
import { buildEngineOpening, buildEngineAddonOpening, resolveItemInputs, typeAvailability, addonTemplatesForSeries, itemsAffectedByDefaultSeries } from './estimationInherit.js'

const project = { default_series_id: 's1', default_finish_id: 'f1', default_infill_id: 'i1', default_hardware_set_id: 'h1', default_thickness_mm: 1.2, labour_per_sqm: 250, profit_pct: 15 }
const types = { t1: { id: 't1', default_labour_per_sqm: 300 }, t0: { id: 't0', default_labour_per_sqm: 0 } }
const tpl = { id: 'tp1', type_id: 't1' }

describe('resolveItemInputs', () => {
  it('an empty item inherits everything from the project', () => {
    expect(resolveItemInputs({}, project, tpl, types)).toEqual({
      series_id: 's1', finish_id: 'f1', infill_type_id: 'i1', hardware_set_id: 'h1', thickness_mm: 1.2, sash_thickness_mm: null, labour_per_sqm: 250, profit_pct: 15,
    })
  })
  it('explicit item values win', () => {
    const item = { series_id: 's2', alu_finish_id: 'f2', infill_type_id: 'i2', hardware_set_id: 'h2', thickness_mm: 1.5, labour_per_sqm: 100, profit_pct: 20 }
    expect(resolveItemInputs(item, project, tpl, types)).toEqual({
      series_id: 's2', finish_id: 'f2', infill_type_id: 'i2', hardware_set_id: 'h2', thickness_mm: 1.5, sash_thickness_mm: null, labour_per_sqm: 100, profit_pct: 20,
    })
  })
  it('"no infill" / "no hardware set" flags beat the project default (Review Focus 4)', () => {
    const r = resolveItemInputs({ no_infill: true, no_hardware_set: true }, project, tpl, types)
    expect(r.infill_type_id).toBeNull()
    expect(r.hardware_set_id).toBeNull()
  })
  it('a labour rate of 0 is a real value at item and project level (Review Focus 7)', () => {
    expect(resolveItemInputs({ labour_per_sqm: 0 }, project, tpl, types).labour_per_sqm).toBe(0)
    expect(resolveItemInputs({}, { ...project, labour_per_sqm: 0 }, tpl, types).labour_per_sqm).toBe(0)
  })
  it('labour falls back item -> project -> type default (> 0) -> null', () => {
    const noLabour = { ...project, labour_per_sqm: null }
    expect(resolveItemInputs({}, noLabour, tpl, types).labour_per_sqm).toBe(300)
    expect(resolveItemInputs({}, noLabour, { id: 'x', type_id: 't0' }, types).labour_per_sqm).toBeNull()
    expect(resolveItemInputs({}, noLabour, { id: 'x', type_id: null }, types).labour_per_sqm).toBeNull()
    expect(resolveItemInputs({}, noLabour, null, types).labour_per_sqm).toBeNull()
  })
  it('missing everywhere gives nulls, never undefined', () => {
    expect(resolveItemInputs({}, {}, null, {})).toEqual({
      series_id: null, finish_id: null, infill_type_id: null, hardware_set_id: null, thickness_mm: null, sash_thickness_mm: null, labour_per_sqm: null, profit_pct: null,
    })
  })
})

describe('typeAvailability', () => {
  const seriesTypes = [{ series_id: 's1', type_id: 't1' }]
  it('ok when the series offers the template type', () => {
    expect(typeAvailability({ type_id: 't1' }, 's1', seriesTypes)).toBe('ok')
  })
  it('not_offered when the series lacks it', () => {
    expect(typeAvailability({ type_id: 't1' }, 's2', seriesTypes)).toBe('not_offered')
  })
  it('unknown when the template has no type, there is no template, or no series', () => {
    expect(typeAvailability({ type_id: null }, 's1', seriesTypes)).toBe('unknown')
    expect(typeAvailability(null, 's1', seriesTypes)).toBe('unknown')
    expect(typeAvailability({ type_id: 't1' }, null, seriesTypes)).toBe('unknown')
  })
})

describe('addonTemplatesForSeries', () => {
  const seriesTypes = [{ series_id: 's1', type_id: 't1' }]
  const templates = [
    { id: 'a', type_id: 't1', active: true },
    { id: 'b', type_id: 't2', active: true },
    { id: 'c', type_id: null, active: true },
    { id: 'd', type_id: 't1', active: false },
  ]
  it('lists active templates the series offers, plus untyped ones; hides the not-offered and inactive', () => {
    expect(addonTemplatesForSeries(templates, 's1', seriesTypes).map(t => t.id)).toEqual(['a', 'c'])
  })
  it('with no series nothing can be judged, so all active templates are listed', () => {
    expect(addonTemplatesForSeries(templates, null, seriesTypes).map(t => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('itemsAffectedByDefaultSeries', () => {
  const seriesTypes = [{ series_id: 'new', type_id: 't1' }]
  const templatesById = { tp1: { id: 'tp1', type_id: 't1' }, tp2: { id: 'tp2', type_id: 't2' }, tpU: { id: 'tpU', type_id: null } }
  const items = [
    { id: 'i1', series_id: null, template_id: 'tp1' },                       // offered -> fine
    { id: 'i2', series_id: null, template_id: 'tp2' },                       // not offered -> affected
    { id: 'i3', series_id: 'own', template_id: 'tp2' },                      // overrides the series -> not affected
    { id: 'i4', series_id: null, template_id: 'tp1', addon_template_id: 'tp2' }, // add-on not offered -> affected
    { id: 'i5', series_id: null, template_id: 'tpU' },                       // untyped -> cannot judge
  ]
  it('lists only items that inherit the series and whose template or add-on is not offered (Review Focus 2)', () => {
    expect(itemsAffectedByDefaultSeries(items, templatesById, 'new', seriesTypes).map(i => i.id)).toEqual(['i2', 'i4'])
  })
  it('with no new series nothing is affected', () => {
    expect(itemsAffectedByDefaultSeries(items, templatesById, null, seriesTypes)).toEqual([])
  })
})

describe('resolveItemInputs numeric coercion (Task 3 carry-over)', () => {
  it('numeric strings from the DB come out as real numbers; 0 stays 0; junk is unset', () => {
    const r = resolveItemInputs({ thickness_mm: '1.5', labour_per_sqm: '0', profit_pct: '20.5' }, project, tpl, types)
    expect(r.thickness_mm).toBe(1.5)
    expect(r.labour_per_sqm).toBe(0)
    expect(r.profit_pct).toBe(20.5)
    const j = resolveItemInputs({ labour_per_sqm: 'abc' }, { ...project, labour_per_sqm: '250' }, tpl, types)
    expect(j.labour_per_sqm).toBe(250)
    expect(typeof resolveItemInputs({}, { ...project, default_thickness_mm: '1.2' }, tpl, types).thickness_mm).toBe('number')
  })
})

describe('buildEngineOpening', () => {
  const raw = { id: 'it1', opening_no: 'W1', template_id: 'tp1', width_m: '1.5', height_m: 2, panel_count: 2, thickness_mm: null, hardware_set_id: null, labour_per_sqm: null, finish_id: 'LEGACY', infill_type_id: null }
  const infills = { i1: { id: 'i1', price_per_sqm: 500 } }
  it('resolved values (not raw NULLs) land in opening, with finish and infill', () => {
    const r = buildEngineOpening(raw, project, tpl, types, infills)
    expect(r.opening).toMatchObject({ id: 'it1', opening_no: 'W1', template_id: 'tp1', panel_count: 2, thickness_mm: 1.2, hardware_set_id: 'h1', labour_per_sqm: 250 })
    expect(r.seriesId).toBe('s1')
    expect(r.finishId).toBe('f1')
    expect(r.infillType).toEqual(infills.i1)
  })
  it('legacy finish_id is never used as the alu finish', () => {
    expect(buildEngineOpening(raw, { ...project, default_finish_id: null }, tpl, types, infills).finishId).toBeNull()
    expect(buildEngineOpening({ ...raw, alu_finish_id: 'f9' }, project, tpl, types, infills).finishId).toBe('f9')
  })
  it('no_hardware_set beats the project default; no_infill / missing infill gives null', () => {
    expect(buildEngineOpening({ ...raw, no_hardware_set: true }, project, tpl, types, infills).opening.hardware_set_id).toBeNull()
    expect(buildEngineOpening({ ...raw, no_infill: true }, project, tpl, types, infills).infillType).toBeNull()
    expect(buildEngineOpening(raw, project, tpl, types, {}).infillType).toBeNull()
  })
  it('labour 0 at the item stays 0; numeric strings become numbers', () => {
    expect(buildEngineOpening({ ...raw, labour_per_sqm: 0 }, project, tpl, types, infills).opening.labour_per_sqm).toBe(0)
    const o = buildEngineOpening({ ...raw, thickness_mm: '1.5', labour_per_sqm: '120' }, project, tpl, types, infills).opening
    expect(o.thickness_mm).toBe(1.5)
    expect(o.labour_per_sqm).toBe(120)
  })
})

describe('buildEngineAddonOpening', () => {
  const addonTpl = { id: 'ad1', type_id: 't0b' }
  const t = { ...types, t0b: { id: 't0b', default_labour_per_sqm: 180 } }
  const item = { id: 'it1', series_id: 's2', alu_finish_id: 'f2', thickness_mm: 1.5, hardware_set_id: 'hX' }
  const addon = { width_m: 0.5, height_m: 0.4, panel_count: 1 }
  it('same series/finish/thickness as the main item, never a hardware set, geometry from the add-on', () => {
    const r = buildEngineAddonOpening(item, project, addon, addonTpl, t, {})
    expect(r.seriesId).toBe('s2')
    expect(r.finishId).toBe('f2')
    expect(r.opening).toMatchObject({ width_m: 0.5, height_m: 0.4, panel_count: 1, thickness_mm: 1.5, hardware_set_id: null })
  })
  it('labour: item -> project -> the add-on type default (not the main type)', () => {
    const noLabour = { ...project, labour_per_sqm: null }
    expect(buildEngineAddonOpening(item, noLabour, addon, addonTpl, t, {}).opening.labour_per_sqm).toBe(180)
    expect(buildEngineAddonOpening({ ...item, labour_per_sqm: 0 }, noLabour, addon, addonTpl, t, {}).opening.labour_per_sqm).toBe(0)
    expect(buildEngineAddonOpening(item, project, addon, addonTpl, t, {}).opening.labour_per_sqm).toBe(250)
  })
})

describe('labour default through ancestors', () => {
  it('a grandchild with no rate of its own or its parent uses the top-level rate', () => {
    const ts = {
      top: { id: 'top', default_labour_per_sqm: 300, parent_id: null },
      mid: { id: 'mid', default_labour_per_sqm: null, parent_id: 'top' },
      leaf: { id: 'leaf', default_labour_per_sqm: null, parent_id: 'mid' },
    }
    expect(resolveItemInputs({}, {}, { id: 'x', type_id: 'leaf' }, ts).labour_per_sqm).toBe(300)
  })
})

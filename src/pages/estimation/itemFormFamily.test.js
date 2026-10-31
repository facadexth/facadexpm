import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { withFamilyResolver } from '../../lib/seriesFamily.js'
import { reconcileItemForm, itemSeriesOptions, itemSeriesHint, hardwareSetHint } from './itemForm.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'Alumet' }],
  seriesFamilies: [{ id: 'fH', provider_id: 'A', name: 'HOMELIFE' }],
  series: [
    { id: 'h1', provider_id: 'A', name: 'HL 2000 Slide', series_family_id: 'fH' },
    { id: 'h2', provider_id: 'A', name: 'HL 268 Slide', series_family_id: 'fH' },
    { id: 'h3', provider_id: 'A', name: 'HL 5000 Door', series_family_id: 'fH' },
    { id: 'x', provider_id: 'A', name: 'AAA other' },
  ],
  types: [{ id: 'slide', name: 'บานเลื่อน' }, { id: 'door', name: 'ประตูบานเปิด' }, { id: 'awning', name: 'บานกระทุ้ง' }],
  seriesTypes: [{ series_id: 'h1', type_id: 'slide' }, { series_id: 'h2', type_id: 'slide' }, { series_id: 'h3', type_id: 'door' }],
  profiles: [{ id: 'p', provider_id: 'A', thickness_mm: 1.2 }],
  seriesProfiles: [{ series_id: 'h3', profile_id: 'p' }],
})
const seriesTypes = Object.values(index.seriesTypesBySeries).flat()
const project = withFamilyResolver({ id: 'pj', default_series_family_id: 'fH', primary_provider_id: 'A' }, index, seriesTypes)

describe('item form with a project series family', () => {
  it('options: the family series of this type first, then the rest of the extruder', () => {
    expect(itemSeriesOptions({ index, project, typeId: 'slide', seriesTypes }).map(o => o.value)).toEqual(['h1', 'h2', 'x', 'h3'])
  })
  it('several family series for one type: a small hint', () => {
    expect(itemSeriesHint({ index, project, template: { type_id: 'slide' }, seriesTypes, ownSeriesId: '' }))
      .toEqual({ hint: 'ซีรีส์หลักนี้มี 2 ชุดบานเลื่อน — เลือกได้ที่นี่' })
  })
  it('no family series for the type: a warning, unless the item picked its own series', () => {
    expect(itemSeriesHint({ index, project, template: { type_id: 'awning' }, seriesTypes, ownSeriesId: '' }))
      .toEqual({ warn: 'ซีรีส์หลัก HOMELIFE ไม่มีชุดสำหรับประเภทนี้ — เลือกชุดในรายการ' })
    expect(itemSeriesHint({ index, project, template: { type_id: 'awning' }, seriesTypes, ownSeriesId: 'x' })).toBeNull()
  })
  it('one family series, or a project without a family: no hint', () => {
    expect(itemSeriesHint({ index, project, template: { type_id: 'door' }, seriesTypes, ownSeriesId: '' })).toBeNull()
    expect(itemSeriesHint({ index, project: { default_series_id: 'x' }, template: { type_id: 'slide' }, seriesTypes, ownSeriesId: '' })).toBeNull()
  })
  it('reconcileItemForm reads the thickness of the series the family gives this template', () => {
    const f = reconcileItemForm({ series_id: '', thickness_mm: '', sash_thickness_mm: '' }, { series_id: '', thickness_mm: '', sash_thickness_mm: '' },
      { index, project, template: { type_id: 'door' }, isNew: true })
    expect(f.thickness_mm).toBe('1.2')
  })
})

describe('item series options use the saved family extruder (controller ruling S3)', () => {
  const idx = buildCatalogIndex({
    providers: [{ id: 'A', name: 'Alumet' }, { id: 'B', name: 'SMS' }],
    seriesFamilies: [{ id: 'fH', provider_id: 'A', name: 'HOMELIFE' }],
    series: [
      { id: 'h1', provider_id: 'A', name: 'HL 2000 Slide', series_family_id: 'fH' },
      { id: 'h3', provider_id: 'A', name: 'HL 5000 Door', series_family_id: 'fH' },
      { id: 'x', provider_id: 'A', name: 'AAA other' },
      { id: 'b1', provider_id: 'B', name: 'SMS 230' },
    ],
    types: [{ id: 'slide', name: 'บานเลื่อน' }, { id: 'door', name: 'ประตูบานเปิด' }],
    seriesTypes: [{ series_id: 'h1', type_id: 'slide' }, { series_id: 'h3', type_id: 'door' }, { series_id: 'b1', type_id: 'slide' }],
  })
  const sts = Object.values(idx.seriesTypesBySeries).flat()
  it("a family of extruder A with primary_provider_id B lists A's series only, the family's for the type first", () => {
    const pj = withFamilyResolver({ id: 'pj', default_series_family_id: 'fH', primary_provider_id: 'B' }, idx, sts)
    expect(itemSeriesOptions({ index: idx, project: pj, typeId: 'slide', seriesTypes: sts }).map(o => o.value)).toEqual(['h1', 'x', 'h3'])
  })
  it('without a family the main extruder (primary_provider_id) is kept', () => {
    expect(itemSeriesOptions({ index: idx, project: { default_series_id: 'b1', primary_provider_id: 'B' }, typeId: 'slide', seriesTypes: sts }).map(o => o.value)).toEqual(['b1'])
  })
})

describe('hardwareSetHint', () => {
  it('with a series: its sets first, unlinked sets for every series', () => {
    expect(hardwareSetHint({ name: 'HL 2000 Slide' }, 3)).toBe('ชุดที่ใช้กับ HL 2000 Slide ขึ้นก่อน · ชุดที่ไม่ผูกซีรีส์ใช้ได้ทุกซีรีส์')
  })
  it('no series but unlinked sets are listed: never says "เลือกซีรีส์ก่อน"', () => {
    expect(hardwareSetHint(null, 2)).toBe('ชุดที่ไม่ผูกซีรีส์ใช้ได้ทุกซีรีส์')
  })
  it('no series and an empty list: เลือกซีรีส์ก่อน', () => {
    expect(hardwareSetHint(null, 0)).toBe('เลือกซีรีส์ก่อน')
  })
})

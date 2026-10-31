import { describe, it, expect } from 'vitest'
import { startModel } from '../../lib/partModel.js'
import {
  templateThumb, thumbSample, isDoorType, templateInitials, typeChips, filterTemplates, templatesUnderPath, pickTemplate,
  rootTypeId, templateMeta, THUMB_SAMPLE, DOOR_SAMPLE, NO_TYPE,
} from './templateCards.js'

const typesById = {
  win: { id: 'win', name: 'หน้าต่าง' }, slide: { id: 'slide', name: 'บานเลื่อน', parent_id: 'win' }, s2: { id: 's2', name: 'สวน 2', parent_id: 'slide' },
  door: { id: 'door', name: 'ประตู' }, swing: { id: 'swing', name: 'บานสวิง', parent_id: 'door' },
  wall: { id: 'wall', name: 'ผนังกระจก' },
}
const base = { grid_row_weights: [1], active: true }
const tWin = { ...base, id: 'a', name: 'บานเลื่อนสวน 2 บาน ทั่วไป', type_id: 's2' }
const tDoor = { ...base, id: 'b', name: 'บานสวิงคู่', type_id: 'swing' }
const tWall = { ...base, id: 'c', name: 'Curtain Wall Stick', type_id: 'wall' }
const tNone = { ...base, id: 'd', name: 'ไม่มีประเภท', type_id: null }
const tOff = { ...base, id: 'e', name: 'ปิดแล้ว', type_id: 'slide', active: false }
const all = [tWin, tDoor, tWall, tNone, tOff]
const slidingModel = () => {
  const m = startModel('sliding_2')
  for (const k of Object.keys(m.lines)) m.lines[k][0].profile_family = 'FR'
  return m
}

describe('templateThumb', () => {
  it('a layout_kind template with its model: the bare part drawing as a safe data URI', () => {
    const t = { ...tWin, layout_kind: 'sliding_2' }
    const th = templateThumb({ template: t, typesById, partModelByTemplate: { a: slidingModel() } })
    expect(th.kind).toBe('part')
    expect(th.src.startsWith('data:image/svg+xml')).toBe(true)
    expect(decodeURIComponent(th.src)).not.toContain('ม.</text>')
  })
  it('a layout_kind template without (or with a broken) model: the placeholder, never a crash', () => {
    const t = { ...tWin, layout_kind: 'sliding_2' }
    expect(templateThumb({ template: t, typesById, partModelByTemplate: {} })).toEqual({ kind: 'none', initials: 'บา' })
    expect(templateThumb({ template: t, typesById, partModelByTemplate: { a: { error: 'x' } } }).kind).toBe('none')
    expect(templateThumb({ template: t, typesById, partModelByTemplate: { a: { layout_kind: 'sliding_2', lines: null, parts: 3 } } }).kind).toBe('none')
  })
  it('any other template: the frame preview with no dimension lines', () => {
    const th = templateThumb({ template: tWin, typesById })
    expect(th.kind).toBe('frame')
    expect(th.preview.dims).toEqual([])
    expect(th.preview.units.length).toBe(1)
  })
  it('a door draws taller than wide; a window wider than tall', () => {
    const d = templateThumb({ template: tDoor, typesById }).preview.units[0].outer
    const w = templateThumb({ template: tWin, typesById }).preview.units[0].outer
    expect(d.h).toBeGreaterThan(d.w)
    expect(w.w).toBeGreaterThan(w.h)
  })
  it('bad data falls back to the placeholder', () => {
    expect(templateThumb({ template: null })).toEqual({ kind: 'none', initials: '?' })
    expect(templateThumb({ template: { id: 'x', name: 'AB', grid_row_weights: 'junk', layout_kind: null } }).kind).toBe('frame')
    expect(templateThumb({ template: { id: 'x', name: 'zz top', layout_kind: 'nope' }, partModelByTemplate: { x: { layout_kind: 'nope' } } })).toEqual({ kind: 'none', initials: 'ZZ' })
  })
})

describe('sample size and initials', () => {
  it('door = a type or parent named ประตู', () => {
    expect(isDoorType(typesById, 'swing')).toBe(true)
    expect(isDoorType(typesById, 's2')).toBe(false)
    expect(isDoorType(typesById, null)).toBe(false)
    expect(thumbSample(tDoor, typesById)).toEqual(DOOR_SAMPLE)
    expect(thumbSample(tWin, typesById)).toEqual(THUMB_SAMPLE)
    expect(thumbSample(tWin, null)).toEqual(THUMB_SAMPLE)
  })
  it('initials', () => {
    expect(templateInitials('Curtain wall')).toBe('CU')
    expect(templateInitials('  ')).toBe('?')
    expect(templateInitials(null)).toBe('?')
  })
})

describe('chips, search, meta', () => {
  it('root types from the tree (by name) with counts, all first, typeless last', () => {
    expect(typeChips(all, typesById)).toEqual([
      { id: '', label: 'ทั้งหมด', count: 5 },
      { id: 'door', label: 'ประตู', count: 1 },
      { id: 'wall', label: 'ผนังกระจก', count: 1 },
      { id: 'win', label: 'หน้าต่าง', count: 2 },
      { id: NO_TYPE, label: 'ไม่ระบุประเภท', count: 1 },
    ])
    expect(typeChips([], typesById)).toEqual([{ id: '', label: 'ทั้งหมด', count: 0 }])
  })
  it('rootTypeId / meta', () => {
    expect(rootTypeId(typesById, 's2')).toBe('win')
    expect(rootTypeId(typesById, null)).toBe(null)
    expect(templateMeta(tWin, typesById)).toBe('หน้าต่าง › บานเลื่อน › สวน 2')
    expect(templateMeta(tNone, typesById)).toBe('')
  })
  it('filter by chip and search (every word, name or type, case-insensitive)', () => {
    const ids = r => r.map(t => t.id)
    expect(ids(filterTemplates(all, { typesById }))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(filterTemplates(all, { rootId: 'win', typesById }))).toEqual(['a', 'e'])
    expect(ids(filterTemplates(all, { rootId: NO_TYPE, typesById }))).toEqual(['d'])
    expect(ids(filterTemplates(all, { query: 'curtain', typesById }))).toEqual(['c'])
    expect(ids(filterTemplates(all, { query: 'หน้าต่าง 2', typesById }))).toEqual(['a'])
    expect(ids(filterTemplates(all, { query: 'ประตู', rootId: 'win', typesById }))).toEqual([])
    expect(ids(filterTemplates(null, { query: 'x' }))).toEqual([])
  })
})

describe('item form', () => {
  it('templatesUnderPath: all active with no type, narrowed by the deepest chosen level, current kept', () => {
    const ids = r => r.map(t => t.id)
    expect(ids(templatesUnderPath(all, typesById, [], null))).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(templatesUnderPath(all, typesById, ['win'], null))).toEqual(['a'])
    expect(ids(templatesUnderPath(all, typesById, ['win', 'slide', 's2'], null))).toEqual(['a'])
    expect(ids(templatesUnderPath(all, typesById, ['door'], 'e'))).toEqual(['b', 'e'])
    expect(ids(templatesUnderPath(all, typesById, ['door'], 'b'))).toEqual(['b'])
  })
  it('pickTemplate sets the template and the cascade path to its type', () => {
    expect(pickTemplate(typesById, tWin)).toEqual({ template_id: 'a', path: ['win', 'slide', 's2'] })
    expect(pickTemplate(typesById, tDoor)).toEqual({ template_id: 'b', path: ['door', 'swing'] })
    expect(pickTemplate(typesById, tNone)).toEqual({ template_id: 'd', path: [] })
  })
})

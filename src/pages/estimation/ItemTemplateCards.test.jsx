// @vitest-environment jsdom
// Item form: the BOM template is picked from picture cards. A card sets template_id AND the type cascade to its type;
// a type chosen in the cascade narrows the cards; the item is saved with the picked template.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { mergeSettings } from '../../lib/estimationSettings.js'

const calls = []
vi.mock('../../lib/supabase.js', () => {
  const chain = (table, op, payload) => {
    const q = { eq: () => q, select: () => q, single: async () => { calls.push({ table, op, payload }); return { data: { id: 'o1' }, error: null } } }
    return q
  }
  return {
    supabase: { from: (table) => ({ update: (p) => chain(table, 'update', p), insert: (p) => chain(table, 'insert', p) }) },
    fmt: n => (n == null || isNaN(n) ? '—' : Number(n).toFixed(2)),
  }
})
const { default: ItemModal } = await import('./ItemModal.jsx')

afterEach(() => { cleanup(); calls.length = 0 })

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'โรงรีด A', price_basis: 'per_kg' }],
  series: [{ id: 'sA', provider_id: 'A', name: 'Demo 40' }],
  types: [{ id: 'win', name: 'หน้าต่าง' }, { id: 'slide', name: 'บานเลื่อน', parent_id: 'win' }, { id: 'fixed', name: 'บานติดตาย', parent_id: 'win' }, { id: 'door', name: 'ประตู' }],
  seriesTypes: [{ series_id: 'sA', type_id: 'win' }, { series_id: 'sA', type_id: 'door' }],
  finishes: [{ id: 'fA', provider_id: 'A', name: 'ขาว' }],
  profiles: [], seriesProfiles: [],
})
const baseT = { active: true, grid_row_weights: [1], waste_pct: 5, labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0, main_axis: 'vertical', preview_kind: 'fixed' }
const tS = { ...baseT, id: 'tS', name: 'เลื่อน 2 บาน', type_id: 'slide' }
const tF = { ...baseT, id: 'tF', name: 'ติดตาย', type_id: 'fixed' }
const tD = { ...baseT, id: 'tD', name: 'ประตูบานเดี่ยว', type_id: 'door' }
const ctx = { templatesById: { tS, tF, tD }, componentsByTemplate: {}, hardwareByTemplate: {}, jointsByTemplate: {}, typesById: index.types, infillTypesById: {}, index, settings: mergeSettings(null), packageItems: null, partModelByTemplate: {} }
const project = { id: 'p1', default_series_id: 'sA', default_finish_id: 'fA', default_thickness_mm: 1.4, price_as_of: '2026-10-01', description_format: ['item_name', 'size'] }
const props = { project, ctx, templates: [tS, tF, tD], constraints: [], infillTypes: [], layoutTemplates: [], seriesTypes: [], canEdit: true, onClose() {}, onSaved() {}, onLayoutSaved() {} }
const cascade = () => screen.getAllByRole('combobox').filter(s => [...s.options].some(o => o.textContent === 'หน้าต่าง' || o.textContent === 'บานเลื่อน'))
const card = name => screen.getByTitle(name)

describe('item form template cards', () => {
  it('a new item shows every active template; a card sets the template and the cascade path', async () => {
    render(<ItemModal {...props} opening={null} currentSig={null} />)
    expect(['เลื่อน 2 บาน', 'ติดตาย', 'ประตูบานเดี่ยว'].every(n => card(n))).toBe(true)
    fireEvent.click(card('เลื่อน 2 บาน'))
    expect(card('เลื่อน 2 บาน').getAttribute('aria-pressed')).toBe('true')
    expect(cascade().map(s => s.value)).toEqual(['win', 'slide'])
    // the cascade now narrows the cards to บานเลื่อน
    expect(screen.queryByTitle('ประตูบานเดี่ยว')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('เช่น W-03'), { target: { value: 'W-01' } })
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '1500' } })
    fireEvent.change(screen.getAllByRole('spinbutton')[1], { target: { value: '1200' } })
    fireEvent.click(screen.getByRole('button', { name: /บันทึกรายการ/ }))
    await vi.waitFor(() => expect(calls.find(c => c.table === 'estimation_openings')).toBeTruthy())
    expect(calls.find(c => c.table === 'estimation_openings').payload.template_id).toBe('tS')
  })
  it('choosing the top type in the cascade narrows the cards to it', () => {
    render(<ItemModal {...props} opening={null} currentSig={null} />)
    fireEvent.change(cascade()[0], { target: { value: 'win' } })
    expect(screen.queryByTitle('ประตูบานเดี่ยว')).toBeNull()
    expect(card('ติดตาย')).toBeTruthy()
    fireEvent.click(card('ติดตาย'))
    expect(cascade().map(s => s.value)).toEqual(['win', 'fixed'])
  })
})

// @vitest-environment jsdom
// Item form for layout kinds (Task 10): the layout's estimator inputs the type does not fix appear under W / H, they
// change the drawing and are SAVED as estimation_openings.layout_params; curtain-wall cells cycle on the item preview.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { mergeSettings } from '../../lib/estimationSettings.js'
import { startModel } from '../../lib/partModel.js'

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
  types: [{ id: 'win', name: 'หน้าต่าง' }],
  seriesTypes: [{ series_id: 'sA', type_id: 'win' }],
  finishes: [{ id: 'fA', provider_id: 'A', name: 'ขาว' }],
  profiles: [], seriesProfiles: [],
})
const baseT = { type_id: 'win', active: true, grid_row_weights: [1], waste_pct: 5, labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0, main_axis: 'vertical', preview_kind: 'fixed' }
const project = { id: 'p1', default_series_id: 'sA', default_finish_id: 'fA', default_thickness_mm: 1.4, price_as_of: '2026-10-01', description_format: ['item_name', 'size'] }

function setup(kind, params = {}, openingExtra = {}) {
  const t = { ...baseT, id: 'tK', name: 'แบบ ' + kind, layout_kind: kind }
  const model = startModel(kind, params)
  const ctx = { templatesById: { tK: t }, componentsByTemplate: {}, hardwareByTemplate: {}, jointsByTemplate: {}, typesById: index.types, infillTypesById: {}, index, settings: mergeSettings(null), packageItems: null, partModelByTemplate: { tK: model } }
  const opening = { id: 'o1', project_id: 'p1', opening_no: 'W-01', template_id: 'tK', width_m: 2.4, height_m: 1.8, panel_count: 1, quantity: 1, extra_lines: [], ...openingExtra }
  const props = { project, ctx, templates: [t], constraints: [], infillTypes: [], layoutTemplates: [], seriesTypes: [], canEdit: true, onClose() {}, onSaved() {}, onLayoutSaved() {} }
  return render(<ItemModal {...props} opening={opening} currentSig={null} />)
}
const panel = () => within(screen.getByRole('group', { name: 'ค่าของแบบชิ้นส่วน' }))
const svgOf = (c) => decodeURIComponent(c.querySelector('img[src^="data:image/svg+xml"]').getAttribute('src').split(',').slice(1).join(','))

describe('item form layout inputs', () => {
  it('sliding_n shows n (the template value), and the door flag (fixed by the type) is not shown', () => {
    setup('sliding_n', { n: 2 })
    expect(panel().getByLabelText(/จำนวนบาน/).value).toBe('2')
    expect(panel().queryByLabelText(/ประตู/)).toBeNull()
  })
  it('sliding_n: changing n redraws and the item is saved with layout_params', async () => {
    const { container } = setup('sliding_n', { n: 2 })
    const before = svgOf(container)
    fireEvent.change(panel().getByLabelText(/จำนวนบาน/), { target: { value: '3' } })
    expect(svgOf(container)).not.toBe(before)
    fireEvent.click(screen.getByRole('button', { name: /บันทึกรายการ/ }))
    await vi.waitFor(() => expect(calls.find(c => c.table === 'estimation_openings')).toBeTruthy())
    expect(calls.find(c => c.table === 'estimation_openings').payload.layout_params).toEqual({ n: 3 })
  })
  it('awning_grid shows no rows / cols (the type fixes them), only the opening direction', () => {
    setup('awning_grid', { rows: 2, cols: 2 })
    expect(panel().queryByLabelText(/จำนวนแถว/)).toBeNull()
    expect(panel().queryByLabelText(/จำนวนช่อง/)).toBeNull()
    expect(panel().getByLabelText(/^เปิด/).tagName).toBe('SELECT')
  })
  it('an item without layout params saves no layout_params key (works before the column exists)', async () => {
    setup('awning_grid', { rows: 2, cols: 2 })
    fireEvent.click(screen.getByRole('button', { name: /บันทึกรายการ/ }))
    await vi.waitFor(() => expect(calls.find(c => c.table === 'estimation_openings')).toBeTruthy())
    expect(calls.find(c => c.table === 'estimation_openings').payload).not.toHaveProperty('layout_params')
  })
  it('swing door with one leaf shows the hinge side (only_when leaves = 1)', () => {
    setup('swing_door', { leaves: 1 })
    expect(panel().getByLabelText(/บานพับด้าน/)).toBeTruthy()
    cleanup()
    setup('swing_door', { leaves: 2 })
    expect(panel().queryByLabelText(/บานพับด้าน/)).toBeNull()
  })
  it('folding door 0 + 0 on the item shows the hint instead of the drawing', () => {
    const { container } = setup('folding_door')
    fireEvent.change(panel().getByLabelText(/จำนวนบานพับซ้าย/), { target: { value: '0' } })
    fireEvent.change(panel().getByLabelText(/จำนวนบานพับขวา/), { target: { value: '0' } })
    expect(screen.getAllByText(/ใส่จำนวนบานซ้าย\/ขวา/).length).toBeGreaterThan(0)
    expect(container.querySelector('img[src^="data:image/svg+xml"]')).toBeNull()
  })
  it('curtain wall: clicking a cell on the item preview cycles it and saves layout_params.cells', async () => {
    const { container } = setup('curtain_wall', { rows: 2, cols: 2 })
    const cell = () => container.querySelector('[data-cell="1,0"]')
    expect(cell().getAttribute('data-kind')).toBe('glass')
    fireEvent.click(cell())
    expect(cell().getAttribute('data-kind')).toBe('awning')
    fireEvent.click(screen.getByRole('button', { name: /บันทึกรายการ/ }))
    await vi.waitFor(() => expect(calls.find(c => c.table === 'estimation_openings')).toBeTruthy())
    expect(calls.find(c => c.table === 'estimation_openings').payload.layout_params).toEqual({ cells: { '1,0': 'awning' } })
  })
})

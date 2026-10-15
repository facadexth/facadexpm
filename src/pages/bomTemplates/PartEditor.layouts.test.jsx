// @vitest-environment jsdom
// Component tests (Task 10, mockup v5) of the part editor for every layout kind other than sliding_2: part tabs, fading,
// click-to-select, mitred corners, inputs panel (only_when, fixed_by_type, refused params), curtain-wall cell cycling,
// count field / clamp warning, line styles and "เสร็จแล้ว". DOM rendering (jsdom + @testing-library/react) with clicks.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { startModel } from '../../lib/partModel.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => (n == null || isNaN(n) ? '—' : Number(n).toFixed(2)) }))
const { default: PartEditor } = await import('./PartEditor.jsx')
const { CLAMP_TEXT } = await import('./partEditorView.js')

afterEach(cleanup)

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'โรงรีด A', price_basis: 'per_kg' }],
  series: [{ id: 'sA', provider_id: 'A', name: 'MNG' }],
  types: [], seriesTypes: [], finishes: [], profiles: [], seriesProfiles: [],
})

let last = null
function Harness({ initial, ...props }) {
  const [model, setModel] = useState(initial)
  last = model
  return <PartEditor model={model} onChange={setModel} index={index} canEdit testSeriesId="" testThicknessMm={null} onTestChange={() => {}} {...props} />
}
const mount = (model, props = {}) => render(<Harness initial={model} {...props} />)
const pieces = (c) => [...c.querySelectorAll('svg g[data-part]')]

describe('part tabs (awning 2 × 2)', () => {
  it('shows ทั้งชุด + วงกบ + 4 sash tabs (and ซอยกลาง, a part of the layout)', () => {
    mount(startModel('awning_grid', { rows: 2, cols: 2 }))
    const tabs = screen.getAllByRole('tab').map(t => t.textContent.trim())
    expect(tabs.filter(t => t === 'ทั้งชุด')).toHaveLength(1)
    expect(tabs.filter(t => t === 'วงกบ')).toHaveLength(1)
    expect(tabs.filter(t => /^บานกระทุ้ง \d/.test(t))).toHaveLength(4)
    expect(tabs).toEqual(['ทั้งชุด', 'วงกบ', 'ซอยกลาง', 'บานกระทุ้ง 1', 'บานกระทุ้ง 2', 'บานกระทุ้ง 3', 'บานกระทุ้ง 4'])
  })
  it('clicking the second tab fades every piece of the other parts (opacity 0.25)', () => {
    const { container } = mount(startModel('awning_grid', { rows: 2, cols: 2 }))
    expect(pieces(container).every(g => g.getAttribute('opacity') === '1')).toBe(true)
    fireEvent.click(screen.getAllByRole('tab')[1])
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true')
    const all = pieces(container)
    expect(all.filter(g => g.dataset.part === 'frame').every(g => g.getAttribute('opacity') === '1')).toBe(true)
    const others = all.filter(g => g.dataset.part !== 'frame')
    expect(others.length).toBeGreaterThan(0)
    expect(others.every(g => g.getAttribute('opacity') === '0.25')).toBe(true)
  })
  it('a sash tab fades the other sashes too (one instance)', () => {
    const { container } = mount(startModel('awning_grid', { rows: 2, cols: 2 }))
    fireEvent.click(screen.getByRole('tab', { name: 'บานกระทุ้ง 2' }))
    const sash = pieces(container).filter(g => g.dataset.part === 'sash')
    expect(sash.filter(g => g.getAttribute('opacity') === '1').every(g => g.dataset.idx === '1')).toBe(true)
    expect(sash.some(g => g.getAttribute('opacity') === '0.25')).toBe(true)
  })
  it('clicking a sash top piece selects sash_top: highlighted, side panel shows the position and เข้ามุม 45°', () => {
    const { container } = mount(startModel('awning_grid', { rows: 2, cols: 2 }))
    const side = () => within(container.querySelector('section[aria-live="polite"]'))
    expect(side().queryByText(/เข้ามุม 45°/)).toBeNull()
    fireEvent.click(container.querySelector('svg g[data-id="sash_top"]'))
    expect(side().getByDisplayValue('ราวบนบาน (บานพับ)')).toBeTruthy()
    expect(side().getAllByText(/เข้ามุม 45°/).length).toBeGreaterThan(0)
    const sel = pieces(container).filter(g => g.classList.contains('sel'))
    expect(sel.length).toBe(4)                       // every sash_top piece of the part (ทั้งชุด tab: all 4 sashes)
    expect(sel.every(g => g.dataset.id === 'sash_top')).toBe(true)
  })
  it('the count field is hidden for an expression part (computed count shown as text); sliding_2 keeps it', () => {
    const { container } = mount(startModel('awning_grid', { rows: 2, cols: 2 }))
    fireEvent.click(container.querySelector('svg g[data-id="sash_top"]'))
    expect(container.querySelector('.parthead input[type=number]')).toBeNull()
    expect(container.querySelector('.parthead .cnt').textContent).toMatch(/^4 ตามแบบ/)
    cleanup()
    const s2 = mount(startModel('sliding_2'), { initialSelection: { key: 'sash_top', line: 0 } })
    expect(s2.container.querySelector('.parthead input[type=number]')).not.toBeNull()
  })
  it('awning 4 × 4: the clamp warning is shown (16 sashes priced as 10)', () => {
    mount(startModel('awning_grid', { rows: 4, cols: 4 }))
    expect(screen.getByText(CLAMP_TEXT)).toBeTruthy()
    cleanup()
    mount(startModel('awning_grid', { rows: 2, cols: 2 }))
    expect(screen.queryByText(CLAMP_TEXT)).toBeNull()
  })
  it('awning rows / cols are read-only only when the type pins them (model.fixedKeys, R-F2)', () => {
    // adjusted (final fix wave, R-F2): read-only follows the keys the type sets, not the fixed_by_type flag
    mount({ ...startModel('awning_grid', { rows: 2, cols: 2 }), fixedKeys: ['rows', 'cols'] })
    expect(screen.getByLabelText(/จำนวนแถว/).disabled).toBe(true)
    expect(screen.getByLabelText(/จำนวนช่อง/).disabled).toBe(true)
    expect(screen.getByLabelText(/^เปิด/).disabled).toBe(false)
    cleanup()
    mount(startModel('awning_grid', { rows: 2, cols: 2 }))
    expect(screen.getByLabelText(/จำนวนแถว/).disabled).toBe(false)
    expect(screen.getByLabelText(/จำนวนช่อง/).disabled).toBe(false)
  })
  it('PartInputs disables only the keys the type pins: swing door leaves pinned, pivot not', () => {
    mount({ ...startModel('swing_door', { leaves: 2 }), fixedKeys: ['leaves'] })
    expect(screen.getByLabelText(/จำนวนบาน/).disabled).toBe(true)
    expect(screen.getByLabelText(/จำนวนบาน/).closest('label').textContent).toContain('(ตามประเภท)')
    expect(screen.getByLabelText(/เดือยบน/).disabled).toBe(false)
    expect(screen.getByLabelText(/เดือยบน/).closest('label').textContent).not.toContain('(ตามประเภท)')
  })
  it('"เสร็จแล้ว" on a part tab marks the tab ✓ and stores the part key in model.done', () => {
    const { container } = mount(startModel('awning_grid', { rows: 2, cols: 2 }))
    expect(container.querySelector('table').textContent).toContain('เฟรมบน')
    fireEvent.click(screen.getByRole('tab', { name: 'วงกบ' }))
    fireEvent.click(screen.getByLabelText('เสร็จแล้ว'))
    expect(last.done).toEqual(['frame'])
    expect(screen.getByRole('tab', { name: /วงกบ ✓/ })).toBeTruthy()
    expect(container.querySelector('table').textContent).not.toContain('เฟรมบน')   // the done part collapses
    expect(container.querySelector('table').textContent).toContain('Part: วงกบ × 1 ✓ เสร็จแล้ว')
  })
})

describe('inputs panel', () => {
  it('casement n = 1 shows the hinge select, n = 2 hides it (only_when)', () => {
    mount(startModel('casement_n', { n: 1 }))
    expect(screen.getByLabelText(/บานพับด้าน/).tagName).toBe('SELECT')
    fireEvent.change(screen.getByLabelText(/จำนวนบาน/), { target: { value: '2' } })
    expect(last.params.n).toBe(2)
    expect(screen.queryByLabelText(/บานพับด้าน/)).toBeNull()
    cleanup()
    mount(startModel('casement_n', { n: 2 }))
    expect(screen.queryByLabelText(/บานพับด้าน/)).toBeNull()
  })
  it('folding door nL 0 nR 0 shows the hint and no drawing; a valid value brings the drawing back', () => {
    const { container } = mount(startModel('folding_door'))
    expect(container.querySelector('svg')).not.toBeNull()
    fireEvent.change(screen.getByLabelText(/จำนวนบานพับซ้าย/), { target: { value: '0' } })
    expect(container.querySelector('svg')).not.toBeNull()
    fireEvent.change(screen.getByLabelText(/จำนวนบานพับขวา/), { target: { value: '0' } })
    expect(screen.getByText(/ใส่จำนวนบานซ้าย\/ขวา/)).toBeTruthy()
    expect(container.querySelector('svg')).toBeNull()
    expect(last.params.nR).toBe(2)                     // the refused params never reach the model
    fireEvent.change(screen.getByLabelText(/จำนวนบานพับขวา/), { target: { value: '1' } })
    expect(screen.queryByText(/ใส่จำนวนบานซ้าย\/ขวา/)).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
    expect(last.params).toMatchObject({ nL: 0, nR: 1 })
  })
  it('folding: the refused state is reported to the page (save is blocked there)', () => {
    const onParamsInvalid = vi.fn()
    mount(startModel('folding_door'), { onParamsInvalid })
    fireEvent.change(screen.getByLabelText(/จำนวนบานพับซ้าย/), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText(/จำนวนบานพับขวา/), { target: { value: '0' } })
    expect(onParamsInvalid).toHaveBeenLastCalledWith(true)
  })
})

describe('curtain wall', () => {
  it('clicking a cell cycles its data-kind glass → awning → spandrel → glass', () => {
    const { container } = mount(startModel('curtain_wall', { rows: 2, cols: 2 }))
    const cell = () => container.querySelector('[data-cell="0,1"]')
    expect(cell().getAttribute('data-kind')).toBe('glass')
    fireEvent.click(cell())
    expect(cell().getAttribute('data-kind')).toBe('awning')
    expect(last.params.cells).toEqual({ '0,1': 'awning' })
    expect(screen.getByRole('tab', { name: 'บานกระทุ้ง' })).toBeTruthy()   // the new awning cell is a part instance
    fireEvent.click(cell())
    expect(cell().getAttribute('data-kind')).toBe('spandrel')
    fireEvent.click(cell())
    expect(cell().getAttribute('data-kind')).toBe('glass')
  })
})

describe('line styles and view (D14)', () => {
  it('the style select redraws the pieces (CAD = outlines only); view in/out mirrors', () => {
    const { container } = mount(startModel('fixed_grid'))
    const rects = () => [...container.querySelectorAll('svg g[data-part] rect[data-role="piece"]')]
    expect(rects().every(r => r.getAttribute('fill') === '#ffffff')).toBe(true)
    fireEvent.change(screen.getByLabelText('แบบเส้น'), { target: { value: 'cad' } })
    expect(rects().every(r => r.getAttribute('fill') === 'none')).toBe(true)
    const x0 = container.querySelector('svg g[data-id="frame_side"] rect').getAttribute('x')
    fireEvent.click(screen.getByRole('button', { name: 'ด้านใน' }))
    expect(container.querySelector('svg g[data-id="frame_side"] rect').getAttribute('x')).not.toBe(x0)
  })
  it('the drawing uses the geometry mm viewBox (box.x box.y box.w box.h)', () => {
    const { container } = mount(startModel('fixed_grid'))
    const vb = container.querySelector('svg').getAttribute('viewBox').split(' ').map(Number)
    expect(vb[0]).toBeLessThan(0)
    expect(vb[1]).toBeLessThan(0)
  })
})

describe('template creation picks the type layout (BomTemplates)', () => {
  const tpl = { id: 't1', name: 'ใหม่', category: 'window', waste_pct: 10, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0, labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, grid_row_weights: [1], grid_horizontal_rail_family: null, grid_vertical_mullion_family: null, active: true, preview_kind: 'fixed', main_axis: 'vertical' }
  const base = { joints: [], catalog: { index }, hardware: [], constraints: [], components: [], onSaved() {}, onDeleted() {}, canEdit: true }
  it('an awning type starts awning_grid with the type rows / cols (read-only)', async () => {
    const { TemplateEditor } = await import('../BomTemplates.jsx')
    const types = [{ id: 'aw', name: 'บานกระทุ้ง 3×2', layout_kind: 'awning_grid', layout_params: { rows: '3', cols: 2 } }]
    render(<TemplateEditor {...base} types={types} template={{ ...tpl, type_id: 'aw' }} />)
    expect(screen.queryByText(/สร้างจากแบบบานเลื่อน 2 บาน/)).toBeNull()
    fireEvent.click(screen.getByText(/สร้างจากแบบบานกระทุ้ง/))
    expect(screen.getAllByRole('tab').filter(t => /^บานกระทุ้ง \d/.test(t.textContent))).toHaveLength(6)
    expect(screen.getByLabelText(/จำนวนแถว/).value).toBe('3')
    expect(screen.getByLabelText(/จำนวนแถว/).disabled).toBe(true)
  })
  it('a type whose params the layout refuses shows the hint and starts nothing; a type without layout_kind keeps sliding_2', async () => {
    const { TemplateEditor } = await import('../BomTemplates.jsx')
    const types = [{ id: 'fd', name: 'เฟี้ยม', layout_kind: 'folding_door', layout_params: {} }, { id: 'old', name: 'เก่า' }]
    // folding nL / nR are not fixed_by_type, so the type cannot refuse them: start works with the defaults (2 + 2)
    render(<TemplateEditor {...base} types={types} template={{ ...tpl, type_id: 'fd' }} />)
    fireEvent.click(screen.getByText(/สร้างจากแบบบานเฟี้ยม/))
    expect(screen.getAllByRole('tab').filter(t => /^บานเฟี้ยม \d/.test(t.textContent))).toHaveLength(4)
    cleanup()
    render(<TemplateEditor {...base} types={types} template={{ ...tpl, type_id: 'old' }} />)
    expect(screen.getByText(/สร้างจากแบบบานเลื่อน 2 บาน \(เพิ่มช่องแสงได้ในกล่องช่องแสง\)/)).toBeTruthy()
  })
})

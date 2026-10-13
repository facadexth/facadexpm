// @vitest-environment jsdom
// Ruling R-F5 (final fix wave, I6): a template whose type now names another แบบชิ้นส่วน (or a kind this version does not
// know) shows a dedicated message — what to fix — instead of "โหลดไม่สำเร็จ กรุณารีโหลดหน้านี้", and cannot be saved.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { layoutLoadText } from './helpers.js'
import { layoutLabels } from '../../lib/layoutRegistry.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => (n == null || isNaN(n) ? '—' : Number(n).toFixed(2)) }))
const { TemplateEditor } = await import('../BomTemplates.jsx')

afterEach(cleanup)

const index = buildCatalogIndex({ providers: [], series: [], types: [], seriesTypes: [], finishes: [], profiles: [], seriesProfiles: [] })
const tpl = { id: 't1', name: 'เดิม', category: 'window', waste_pct: 10, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0, labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, grid_row_weights: [1], grid_horizontal_rail_family: null, grid_vertical_mullion_family: null, active: true, type_id: 'ty', preview_kind: 'fixed', main_axis: 'vertical' }
const base = { joints: [], catalog: { index }, hardware: [], constraints: [], components: [], onSaved() {}, onDeleted() {}, canEdit: true }

describe('template editor: layout load refusals (R-F5)', () => {
  it('layout_mismatch names both kinds and says what to fix, without "รีโหลด"', async () => {
    render(<TemplateEditor {...base} types={[{ id: 'ty', name: 'บานเลื่อน', layout_kind: 'sliding_n' }]} template={{ ...tpl, layout_kind: 'sliding_2' }} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('แบบชิ้นส่วนของเทมเพลตนี้ (บานเลื่อนสวน 2 บาน) ไม่ตรงกับประเภท (บานเลื่อน n บาน) — แก้แบบชิ้นส่วนที่ประเภทในแคตตาล็อก หรือสร้างเทมเพลตใหม่')
    expect(alert.textContent).not.toContain('รีโหลด')
  })
  it('unknown_layout has its own line', async () => {
    render(<TemplateEditor {...base} types={[{ id: 'ty', name: 'บานเลื่อน' }]} template={{ ...tpl, layout_kind: 'zz_future_kind' }} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('ไม่รู้จักแบบชิ้นส่วนของเทมเพลตนี้ (zz_future_kind)')
    expect(alert.textContent).not.toContain('รีโหลด')
  })
  it('layoutLoadText: null for other errors (the caller keeps its reload wording)', () => {
    expect(layoutLoadText('layout_params_invalid', 'folding_door', 'folding_door', layoutLabels)).toBeNull()
    expect(layoutLoadText('layout_mismatch', 'sliding_2', 'casement_n', layoutLabels)).toContain('(บานเปิดข้าง)')
  })
})

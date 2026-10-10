// Render smoke test for the BOM template part editor (server-side render only: no effects, no clicks, no Supabase).
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { startModel, setEndMode } from '../../lib/partModel.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => (n == null || isNaN(n) ? '—' : Number(n).toFixed(2)) }))
const { default: PartEditor } = await import('./PartEditor.jsx')
const { TemplateEditor } = await import('../BomTemplates.jsx')

// Owner worked example: side frame / top frame butt 38.1, bottom 35.8, stiles 25 (mockup sample numbers).
const FAMS = { FT: [58.1, 38.1], FB: [55.6, 35.8], FS: [51.3, 38.1], ST: [25, 25], SB: [25, 25], KS: [25, 25], HS: [25, 25] }
const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'โรงรีด A', price_basis: 'per_kg' }],
  series: [{ id: 'sA', provider_id: 'A', name: 'MNG' }],
  types: [{ id: 'slide', name: 'บานเลื่อน' }],
  seriesTypes: [{ series_id: 'sA', type_id: 'slide' }],
  finishes: [],
  profiles: Object.entries(FAMS).map(([f, [w, b]]) => ({ id: 'p' + f, provider_id: 'A', family: f, thickness_mm: 1.5, width_mm: w, butt_distance_mm: b, linear_weight_kg_per_m: 1 })),
  seriesProfiles: Object.keys(FAMS).map(f => ({ series_id: 'sA', profile_id: 'p' + f })),
})
const KEYFAM = { frame_top: 'FT', frame_bottom: 'FB', frame_side: 'FS', sash_top: 'ST', sash_bottom: 'SB', key_stile: 'KS', hook_stile: 'HS' }
function owner() {
  const m = startModel('sliding_2')
  for (const [k, f] of Object.entries(KEYFAM)) m.lines[k][0].profile_family = f
  return m
}
const render = (props) => renderToString(
  <PartEditor model={owner()} onChange={() => {}} index={index} canEdit testSeriesId="sA" testThicknessMm={1.5} onTestChange={() => {}} {...props} />,
)
const text = html => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'")

describe('PartEditor renders', () => {
  it('the default model with a catalogue, without NaN / undefined', () => {
    const html = render()
    expect(html).not.toMatch(/NaN|undefined/)
    expect(html).toContain('แก้ชิ้นที่เลือก')
    expect(html).toContain('<svg')
    expect(html).toContain('ภาพขยาย: วงกบ')
    expect(html).toContain('ความยาวต่อชิ้น × ปริมาณ (มม.)')
  })
  it('the bare startModel (no families) also has no NaN / undefined', () => {
    const html = render({ model: startModel('sliding_2'), testSeriesId: '', testThicknessMm: null })
    expect(html).not.toMatch(/NaN|undefined/)
  })
  it('table header and part rows', () => {
    const t = text(render())
    expect(t).toContain('ความยาวต่อชิ้น × ปริมาณ (มม.)ยาวรวม (ม.)')
    expect(t).toContain('Part: วงกบ × 1')
    expect(t).toContain('Part: บานเลื่อน × 2')
    expect(t).toContain('1,723.8 × 1')        // frame top (and bottom), one each
    expect(t).toContain('1,200.0 × 2')        // side frames
    expect(t).toContain('1,126.1 × 2')        // stiles
  })
  it('the rail "ที่มา" line', () => {
    const t = text(render({ initialSelection: { key: 'sash_top', line: 0 } }))
    expect(t).toContain('(กว้าง 1,800.0 − หักวงกบ/ระยะหัก 76.2 + ระยะซ้อนบาน 25.0) × 0.5 − ปลายซ้าย ชน เสาเกี่ยว 25.0 − ปลายขวา ชน เสากุญแจ 25.0 = 824.4 มม.')
    expect(t).toContain('824.4 × 2')
    expect(t).toContain('อัตโนมัติจากวงกบ')
    expect(t).toContain('อัตโนมัติ = ความกว้างเสาเกี่ยว')
  })
  it('unequal lengths add a "↳ ความยาวไม่เท่ากัน" line', () => {
    const m = setEndMode(owner(), 'frame_side', 0, 0, 0, 'butt')   // left side frame butts the top frame
    const t = text(render({ model: m }))
    expect(t).toContain('↳ ความยาวไม่เท่ากัน')
    expect(t).toContain('1,161.9 × 1')
  })
  it('a corner violation shows the banner', () => {
    const m = owner()
    m.lines.frame_side[0].ends[0][0] = { mode: 'through', to: null, deduction_mm: null }
    m.lines.frame_top[0].ends[0][0] = { mode: 'through', to: null, deduction_mm: null }
    const html = render({ model: m })
    expect(html).toContain('role="alert"')
    expect(text(html)).toContain('มุมที่สองชิ้นมาพบกันต้องมีชิ้นหนึ่งวิ่งสุด อีกชิ้นวิ่งชน')
  })
  it('no corner violation, no banner', () => {
    expect(render()).not.toContain('role="alert"')
  })
  it('a template with no profile families shows the unresolved text instead of numbers', () => {
    const t = text(render({ model: startModel('sliding_2') }))
    expect(t).toContain('ยังไม่ได้เลือกอลูมิเนียม จึงยังคิดความยาวไม่ได้')
    expect(t).not.toContain('1,723.8')
    expect(t).not.toContain('ที่มา (')
  })
  it('read-only users get disabled controls and no add / toggle buttons', () => {
    const html = render({ canEdit: false })
    expect(html).not.toContain('+ เพิ่มโปรไฟล์ในตำแหน่งนี้')
    expect(html).not.toContain('กดเพื่อสลับ')
    expect(html).toMatch(/<select disabled=""/)
  })
})

describe('BomTemplates tab 0', () => {
  const catalog = { index }
  const base = { joints: [], catalog, types: [{ id: 'slide', name: 'บานเลื่อน' }], hardware: [], constraints: [], onSaved() {}, onDeleted() {}, canEdit: true }
  const tpl = { id: 't1', name: 'เดิม', category: 'window', waste_pct: 10, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0, labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, grid_row_weights: [1], grid_horizontal_rail_family: null, grid_vertical_mullion_family: null, active: true, type_id: null, preview_kind: 'fixed', main_axis: 'vertical' }
  it('a legacy template (no layout_kind) still renders the old component table', () => {
    const comps = [{ id: 'c1', template_id: 't1', role_name: 'วงกบบน', profile_family: 'FT', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, sort_order: 0 }]
    const html = renderToString(<TemplateEditor {...base} template={tpl} components={comps} />)
    expect(html).toContain('ชิ้นส่วนอลูมิเนียม (Components)')
    expect(html).toContain('value="วงกบบน"')
    expect(html).not.toContain('สร้างจากแบบบานเลื่อน 2 บาน')
    expect(html).not.toContain('แก้ชิ้นที่เลือก')
  })
  it('a new template offers "สร้างจากแบบบานเลื่อน 2 บาน (ไม่มีช่องแสง)"', () => {
    const html = renderToString(<TemplateEditor {...base} template={null} components={[]} />)
    expect(html).toContain('สร้างจากแบบบานเลื่อน 2 บาน (ไม่มีช่องแสง)')
    expect(html).toContain('ชิ้นส่วนอลูมิเนียม (Components)')
  })
  it('a layout_kind template shows the part editor slot (loading until its rows arrive)', () => {
    const html = renderToString(<TemplateEditor {...base} template={{ ...tpl, layout_kind: 'sliding_2' }} components={[]} />)
    expect(html).not.toContain('ชิ้นส่วนอลูมิเนียม (Components)')
    expect(html).toContain('กำลังโหลดข้อมูลชิ้นส่วนของเทมเพลต')
    expect(html).toContain('อุปกรณ์ (Hardware)')
  })
})

describe('part totals without weights', () => {
  it('the part header shows — (not 0.00) when no profile has a weight', () => {
    const t = text(render({ testSeriesId: '', testThicknessMm: null }))
    expect(t).toMatch(/Part: วงกบ × 1[\d.,]+—/)
    expect(t).toMatch(/รวมตำแหน่งนี้ [\d.,]+ ม\. · — กก\./)
  })
})

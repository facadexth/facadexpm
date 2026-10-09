// Render smoke test for the price structure tab (server-side render, no effects/clicks/Supabase).
import { describe, it, expect, vi } from 'vitest'
import { renderToString, renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => (n == null || isNaN(n) ? '—' : Number(n).toFixed(2)) }))
const { default: PriceStructureTab } = await import('./PriceStructureTab.jsx')
const { default: PriceStructureTable } = await import('./PriceStructureTable.jsx')
const { validateFactors } = await import('./ProjectFactorsPanel.jsx')

const bom = (alu, glass) => ({ profileLines: [{ cost: alu, weight_kg: 2 }], gridLines: [], hardwareLines: [], hardwareSetLines: [], infillCost: glass, laborCost: 0, siliconeCost: 0, feltCost: 0, extraLinesCost: 0 })
const cost = (alu, glass) => ({ bom: bom(alu, glass), unresolved: [], resolved: { infill_type_id: 'g1' }, total: alu + glass })
const items = [
  { id: 'a', opening_no: 'W-01', width_m: 1.2, height_m: 1.2, quantity: 2, profit_pct: null },
  { id: 'b', opening_no: 'W-02', width_m: 1, height_m: 2, quantity: 1, profit_pct: 20 },
  { id: 'c', opening_no: 'W-03', width_m: 1, height_m: 1, quantity: 1, profit_pct: null },
]
const costs = {
  a: cost(1000, 500), b: cost(2000, 800),
  c: { bom: null, unresolved: [{ name: 'วงกบบน', reason: 'no_price' }], resolved: {} },
}
const project = { id: 'p1', waste_pct: 5, profit_pct: 15, pm_pct: 3, transport_total: 1234, round_step: 50 }
const infillTypes = [{ id: 'g1', code: 'GL6', name: 'กระจกเขียว 6 มม.', price_per_sqm: 900 }]
const props = { project, items, costs, index: {}, infillTypes, templatesById: {}, canEdit: true, onProjectSaved() {}, onItemsSaved() {}, actions: <button>ส่ง</button> }

describe('PriceStructureTab renders', () => {
  const html = renderToString(<PriceStructureTab {...props} />)
  it('has no NaN / Infinity / undefined', () => {
    for (const bad of ['NaN', 'Infinity', 'undefined']) expect(html).not.toContain(bad)
  })
  it('shows the unresolved row reason', () => {
    expect(html).toContain('W-03')
    expect(html).toContain('วงกบบน')
  })
  it('omits a category that is zero everywhere and has the SUMPRODUCT row', () => {
    expect(html).toContain('อลูมิเนียม')
    expect(html).toContain('กระจก')
    expect(html).not.toContain('<th>อุปกรณ์</th>')
    expect(html).not.toContain('<th>ค่าแรง</th>')
    expect(html).toContain('SUMPRODUCT')
  })
  it('shows the factor values, the glass hover and the actions slot', () => {
    expect(html).toContain('value="1234"')
    expect(html).toContain('value="50"')
    expect(html).toContain('กระจกเขียว 6 มม.')
    expect(html).toContain('บาท/ตร.ฟ.')
    expect(html).toContain('ส่ง')
    expect(html).toContain('น้ำหนักอลูมิเนียมสุทธิ')
  })
  it('follows the mockup structure', () => {
    expect(html).toContain('SUMPRODUCT (ต้นทุน × จำนวน)')
    expect(html).toContain('รวมทั้งโปรเจกต์ (ก่อน VAT)')
    expect(html).toContain('กระจก (รหัส)')
    expect(html).toContain('นน.อลูมิเนียม กก./ชุด')
    expect(html).toContain('สัดส่วนราคาขายต่อชุด × จำนวน (ก่อนปัด)')
    expect(html).toContain('ต้นทุนอลูมิเนียมเฉลี่ย')
    expect(html).toContain('เผื่อเสียเศษ (% ของอลูมิเนียม)')
    expect(html).toContain('ตามโปรเจกต์ 15.0%')
    expect(html).toContain('พื้นที่')
    expect(html).toContain('value="20"')
  })
  it('a missing cost shows the no-template message', () => {
    const h = renderToString(<PriceStructureTab {...props} costs={{ a: costs.a, b: costs.b }} />)
    expect(h).toContain('ไม่พบแบบ (Template) ของรายการนี้')
    expect(h).not.toContain('NaN')
  })
})

describe('profit tick', () => {
  it('the text is inside a label bound to the checkbox', () => {
    const rows = [{ id: 'a', resolved: true, quantity: 1, v: 1, w: 0, x: 0, y: 1, z: 0, pm: 0, perSet: 1, price: 50, perSqm: 1, lineTotal: 50, profitPct: 15, breakdown: {}, extraCosts: {} }]
    const h = renderToStaticMarkup(<PriceStructureTable items={[items[0]]} rows={rows} costs={{ a: costs.a }} infillTypesById={{}} canEdit onItemsSaved={() => {}} />)
    const m = h.match(/<label for="(follow-a)"[^>]*>(.*?)<\/label>/)
    expect(m).toBeTruthy()
    expect(m[2]).toContain('ตามโปรเจกต์')
    expect(m[2]).toContain('<input id="follow-a" type="checkbox"')
  })
})

describe('validateFactors', () => {
  it('rejects negatives and a zero step', () => {
    expect(validateFactors({ waste_pct: '-1', round_step: '10' })).toBeTruthy()
    expect(validateFactors({ waste_pct: '1', round_step: '0' })).toBeTruthy()
    expect(validateFactors({ waste_pct: '1', profit_pct: '', round_step: '10' })).toBeNull()
    for (const k of ['waste_pct', 'profit_pct', 'pm_pct']) {
      expect(validateFactors({ [k]: '1001', round_step: '10' })).toContain('1,000')
      expect(validateFactors({ [k]: '1000', round_step: '10' })).toBeNull()
    }
    expect(validateFactors({ transport_total: '5000000', round_step: '10' })).toBeNull()
  })
})

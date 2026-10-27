// SSR smoke test: the custom-length summary says why custom lengths were dropped (minimum order) or what they save.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(Math.round(n)) }))
const { default: CustomLengthSummary } = await import('./CustomLengthSummary.jsx')
const { summarySource } = await import('./projectBomHelpers.js')

const settings = { stock_length_m: 6.4, custom_moq_kg: 1000 }
const group = (o = {}) => ({ key: 'p1|f1', profile_id: 'p1', finish_id: 'f1', name: 'กรอบบน', die_no: 'D-1', finish_name: 'อบขาว', length_m: 6.25, custom: true, no_weight: false, overrideRejected: false, offcutBars: [], bars: [{}, {}], unplaced: [], kg: 12.5, newOffcuts: [], ...o })
const compare = { 'p1|f1': { base: { length_m: 6.4, newBars: 2, kg: 12.8 }, best: { length_m: 6.25, newBars: 2, kg: 12.5 } } }
// React marks text joins with <!-- -->; drop them so whole sentences can be matched.
const render = (plan, extra = {}) => renderToString(<CustomLengthSummary plan={plan} compare={compare} prices={{ 'p1|f1': 100 }} kgPerM={{ 'p1|f1': 1 }} settings={settings} canEdit onUse={() => {}} onUseAll={() => {}} {...extra} />).replaceAll('<!-- -->', '')

describe('CustomLengthSummary', () => {
  it('warns when the custom lengths miss the minimum order', () => {
    const html = render({ reason: 'moq', customKg: 12.5, moqMet: false, groups: [group({ length_m: 6.4, custom: false, kg: 12.8 })] })
    expect(html).toContain('ไม่ถึงขั้นต่ำ')
    expect(html).toContain('ใช้เส้น 6.40 ม. ทั้งโครงการ')
    expect(html).not.toContain('ประหยัด')
  })
  it('shows the saving against 6.40 m otherwise', () => {
    const html = render({ reason: null, customKg: 1200, moqMet: true, groups: [group()] })
    expect(html).toContain('ประหยัด <b class="font-mono">0.30</b> กก. ≈ <b class="font-mono">30</b> ฿')
    expect(html).toContain('เทียบกับ 6.40 ม.')
    expect(html).toContain('−0.30 กก.')
    expect(html).not.toContain('ใช้ทั้งหมด')   // already on its best length
  })
  it('offers the best length when the plan uses another one, never under the minimum-order fallback', () => {
    const off = render({ reason: null, customKg: 1200, moqMet: true, groups: [group({ length_m: 6.4, custom: false, kg: 12.8 })] })
    expect(off).toContain('ใช้ทั้งหมด')
    expect(off).toContain('ใช้ 6.25')
    const moq = render({ reason: 'moq', customKg: 12.5, moqMet: false, groups: [group({ length_m: 6.4, custom: false, kg: 12.8 })] })
    expect(moq).not.toContain('ใช้ทั้งหมด')
    expect(render({ reason: null, customKg: 1200, moqMet: true, groups: [group({ length_m: 6.4 })] }, { canEdit: false })).not.toContain('ใช้ทั้งหมด')
  })
  it('flags no weight, rejected override and pieces that cannot be cut', () => {
    const html = render({ reason: null, customKg: 0, moqMet: true, groups: [group({ no_weight: true, overrideRejected: true, unplaced: [{}, {}], length_m: 6.4 })] }, { kgPerM: {} })
    expect(html).toContain('ไม่มีน้ำหนัก/ม. ใช้ 6.40 ม.')
    expect(html).toContain('ความยาวที่เลือกตัดไม่ได้ ใช้ความยาวที่ดีที่สุดแทน')
    expect(html).toContain('ตัดไม่ได้ 2 ท่อน')
  })
  it('uses the stock length from the settings', () => {
    const html = render({ reason: 'moq', customKg: 5, moqMet: false, groups: [group({ length_m: 6, custom: false })] }, { settings: { stock_length_m: 6, custom_moq_kg: 1000 } })
    expect(html).toContain('ใช้เส้น 6.00 ม. ทั้งโครงการ')
  })
  it('a group the stock bar cannot cut says so and is left out of the saving; the stock fallback line only when nothing is custom', () => {
    const cmp = { ...compare, 'p2|f1': { base: { length_m: 6.4, newBars: 0, kg: 0, feasible: false }, best: { length_m: 6.6, newBars: 1, kg: 6.6 } } }
    const groups = [group({ length_m: 6.4, custom: false, kg: 12.8 }), group({ key: 'p2|f1', profile_id: 'p2', length_m: 6.6, custom: true, kg: 6.6, bars: [{}] })]
    const html = render({ reason: null, customKg: 6.6, moqMet: true, groups }, { compare: cmp })
    expect(html).toContain('6.40 ตัดไม่ได้')
    expect(html).toContain('ไม่รวม 1 หน้าตัดที่ 6.40 ม. ตัดไม่ได้')
    expect(html).not.toContain('ความยาวพิเศษไม่ช่วยลดน้ำหนักที่ซื้อ')
    expect(html).toContain('สั่งความยาวพิเศษรวม <b class="font-mono">6.60</b> กก.')
  })
  it('notes that a length applies to every colour of a shared profile', () => {
    const html = render({ reason: null, customKg: 0, moqMet: true, groups: [group({ length_m: 6.4, custom: false }), group({ key: 'p1|f2', finish_id: 'f2', length_m: 6.4, custom: false })] })
    expect(html).toContain('ใช้กับทุกสีของหน้าตัดนี้')
  })
  it('an issued project shows the issued plan, not the live one, and no "ใช้" buttons', () => {
    const live = { reason: null, customKg: 1200, moqMet: true, groups: [group({ length_m: 6.4, custom: false, kg: 3.2, bars: [{}] })] }
    const issued = { id: 'cp1', plan: { reason: null, customKg: 1200, moqMet: true, groups: [group({ length_m: 6.4, custom: false, kg: 12.8, bars: [{}, {}] })] } }
    const html = renderToString(<CustomLengthSummary {...summarySource({ plan: live, issued, canEdit: true })} compare={compare} prices={{ 'p1|f1': 100 }} kgPerM={{ 'p1|f1': 1 }} settings={settings} onUse={() => {}} onUseAll={() => {}} />).replaceAll('<!-- -->', '')
    expect(html).toContain('<b>12.80</b>')
    expect(html).not.toContain('<b>3.20</b>')
    expect(html).not.toContain('ใช้ทั้งหมด')
    expect(html).not.toContain('ใช้ 6.25')
  })
})

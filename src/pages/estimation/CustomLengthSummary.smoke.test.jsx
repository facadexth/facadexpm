// SSR smoke test: the custom-length summary says why custom lengths were dropped (minimum order) or what they save.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(Math.round(n)) }))
const { default: CustomLengthSummary } = await import('./CustomLengthSummary.jsx')

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
})

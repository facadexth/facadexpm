// SSR smoke test: the per-bar cut sheet groups identical new bars, offers the issue button on a live plan, and warns
// when the issued snapshot no longer matches the items.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(n), fmtDate: () => '27 ต.ค. 2569' }))
const { default: CutSheetView } = await import('./CutSheetView.jsx')

const settings = { min_keep_offcut_m: 0.5, stock_length_m: 6.4 }
const pc = (len, no = 'W-01', role = 'กรอบบน') => ({ length_m: len, opening_no: no, item_id: 'i1', item_name: '', role_name: role, end_a: 'square', end_b: 'square', notch: null, kerf_style: 'square' })
const bar = () => ({ length_m: 6.4, left_m: 0.39, pieces: [pc(3), pc(3)] })
const group = o => ({
  key: 'p1|f1', profile_id: 'p1', finish_id: 'f1', die_no: 'MN-101', name: 'กรอบ', finish_name: 'อบขาว', length_m: 6.4, custom: false,
  offcutBars: [{ length_m: 1.2, left_m: 0.19, pieces: [pc(1, 'W-02', 'ตั้ง')], offcut: { id: 'o1', code: 'OC-0001', length_m: 1.2 } }],
  bars: [bar(), bar()], unplaced: [], kg: 10.24, newOffcuts: [], ...o,
})
const plan = (o = {}) => ({ signature: 'S1', groups: [group(o)] })
const render = props => renderToString(<CutSheetView plan={plan()} issued={null} settings={settings} canEdit busy={false} onIssue={() => {}} onVoid={() => {}} {...props} />).replaceAll('<!-- -->', '')

describe('CutSheetView', () => {
  it('shows the live plan with the issue button, the stock offcut first and identical bars as one row', () => {
    const html = render({})
    expect(html).toContain('ยืนยันใบตัด (ตัดเศษสต็อก + สร้างสติกเกอร์)')
    expect(html).toContain('เส้นที่ 1–2 × 2')
    expect(html).toContain('OC-0001')
    expect(html.indexOf('OC-0001')).toBeLessThan(html.indexOf('เส้นที่ 1–2'))
    expect(html).toContain('เศษสต็อก 1 + 2 เส้นใหม่')
    expect(html).toContain('3000')
    expect(html).not.toContain('ใบตัดไม่ตรงกับรายการปัจจุบัน')
  })
  it('blocks issuing while a piece cannot be cut and lists it', () => {
    const html = render({ plan: plan({ unplaced: [pc(7.2, 'W-09', 'ตั้ง')] }) })
    expect(html).toContain('ตัดไม่ได้ — ยาวเกินเส้น')
    expect(html).toContain('มีท่อนที่ตัดไม่ได้ — แก้ก่อนยืนยัน')
    expect(html).toMatch(/disabled=""[^>]*>ยืนยันใบตัด/)
  })
  it('an issued plan with another signature shows the mismatch warning and the void button', () => {
    const html = render({ issued: { id: 'cp1', status: 'issued', signature: 'OLD', issued_at: '2026-10-27T03:00:00Z', plan: plan() } })
    expect(html).toContain('ใบตัดไม่ตรงกับรายการปัจจุบัน — ยกเลิกแล้วยืนยันใหม่ถ้าต้องการใบตัดตามรายการล่าสุด')
    expect(html).toContain('ยืนยันแล้ว 27 ต.ค. 2569')
    expect(html).toContain('ยกเลิกใบตัด')
    expect(html).not.toContain('ยืนยันใบตัด (')
  })
  it('an issued plan matching the items shows no warning', () => {
    const html = render({ issued: { id: 'cp1', status: 'issued', signature: 'S1', issued_at: '2026-10-27T03:00:00Z', plan: plan() } })
    expect(html).not.toContain('ใบตัดไม่ตรงกับรายการปัจจุบัน')
  })

  describe('remainder colour = kept', () => {
    const GREEN = 'rgba(var(--green-rgb), 0.35)'
    const greens = html => html.split(GREEN).length - 1 - 1 // minus the legend swatch
    const offs = [{ key: 'p1|f1#1', bar_ref: '1', length_m: 0.39, end_a: 'square', keep: false }, { key: 'p1|f1#2', bar_ref: '2', length_m: 0.39, end_a: 'square', keep: false },
      { key: 'p1|f1#OC-0001', bar_ref: 'OC-0001', length_m: 0.19, end_a: 'square', keep: false }]
    it('live plan: dropped by default, a flipped bar of a run turns green and gets its own row', () => {
      const p = plan({ newOffcuts: offs })
      expect(greens(render({ plan: p, flipped: new Set() }))).toBe(0)
      const html = render({ plan: p, flipped: new Set(['p1|f1#2']) })
      expect(greens(html)).toBe(1)
      expect(html).toContain('เส้นที่ 1<')
      expect(html).toContain('เส้นที่ 2<')
      expect(html).not.toContain('เส้นที่ 1–2')
    })
    it('issued plan: green exactly where an offcut was stocked, whatever the min-keep rule says', () => {
      const p = plan({ newOffcuts: offs })
      const issued = { id: 'cp1', status: 'issued', signature: 'S1', issued_at: '2026-10-27T03:00:00Z', plan: p }
      expect(greens(render({ plan: p, issued, codes: { 'p1|f1#OC-0001': 'OC-0007' } }))).toBe(1)
      expect(greens(render({ plan: p, issued, codes: {}, flipped: new Set(['p1|f1#1']) }))).toBe(0)
    })
    it('issued plan while the offcut codes load: remainders neutral, neither green nor hatched', () => {
      const HATCH = 'repeating-linear-gradient(45deg'
      const p = plan({ newOffcuts: offs })
      const issued = { id: 'cp1', status: 'issued', signature: 'S1', issued_at: '2026-10-27T03:00:00Z', plan: p }
      const html = render({ plan: p, issued, codes: null })
      expect(greens(html)).toBe(0)
      expect(html.split(HATCH).length - 1).toBe(1) // the legend swatch only
      expect(html).toContain('background:var(--bg3)')
      expect(render({ plan: p, issued, codes: {} }).split(HATCH).length - 1).toBeGreaterThan(1)
    })
  })
  it('grid role names are shown in Thai (same mapping as the stickers), on bars and in the cannot-cut list', () => {
    const html = render({ plan: plan({ bars: [{ length_m: 6.4, left_m: 3.4, pieces: [pc(3, 'W-03', 'Horizontal rail')] }], unplaced: [pc(7.2, 'W-04', 'Vertical mullion')] }) })
    expect(html).toContain('W-03 ซอยนอน')
    expect(html).toContain('W-04 ซอยตั้ง')
    expect(html).not.toContain('Horizontal rail')
    expect(html).not.toContain('Vertical mullion')
  })
})

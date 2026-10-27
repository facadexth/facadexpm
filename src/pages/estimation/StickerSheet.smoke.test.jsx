// SSR smoke test: stickers preview in cutting order; "ไม่เก็บ" ticks work before issue and are locked after it; the
// PDF waits for the issue.
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import StickerSheet from './StickerSheet.jsx'

const pc = (len, o = {}) => ({ length_m: len, opening_no: 'W-01', item_id: 'i1', item_name: '', role_name: 'กรอบบานตั้ง', end_a: 'miter45', end_b: 'miter45', notch: null, kerf_style: 'miter45', ...o })
const group = () => ({
  key: 'A|F', profile_id: 'A', finish_id: 'F', die_no: 'F7980', name: 'กรอบบาน', finish_name: 'อบขาว', length_m: 6.4, offcutBars: [],
  bars: [{ length_m: 6.4, left_m: 0.38, pieces: [pc(3), pc(3, { end_b: 'notch', notch: { joint_name: 'บากรับกรอบนอน', width_mm: 20, depth_mm: 8 } })] },
    { length_m: 6.4, left_m: 2.4, pieces: [pc(4)] }],
  unplaced: [],
  newOffcuts: [{ key: 'A|F#1', bar_ref: '1', length_m: 0.38, end_a: 'notch', keep: false }, { key: 'A|F#2', bar_ref: '2', length_m: 2.4, end_a: 'miter45', keep: true }],
})
const plan = { signature: 'S', groups: [group()] }
const render = props => renderToString(
  <StickerSheet plan={plan} issued={null} codes={null} projectName="PARLLEL TROPICAL" projectId="pj1" openingIds={{}} flipped={new Set()} onFlip={() => {}} {...props} />,
).replaceAll('<!-- -->', '')
const checkboxes = html => [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map(m => m[0])

describe('StickerSheet', () => {
  it('before issue: every remainder has a sticker with an enabled tick, the PDF waits for the issue', () => {
    const html = render({})
    expect(html).toContain('W-01 · กรอบบานตั้ง')
    expect(html).toContain('บากรับกรอบนอน 20×8')
    expect(html).toContain('เส้น 1 · 1/3')
    expect(html).toContain('OC-ใหม่')
    expect(html).toContain('ยืนยันใบตัดก่อน จึงจะได้รหัสเศษสำหรับสติกเกอร์')
    expect(html).toMatch(/disabled=""[^>]*>ดาวน์โหลด PDF สติกเกอร์/)
    const boxes = checkboxes(html)
    expect(boxes).toHaveLength(2)
    expect(boxes.every(b => !b.includes('disabled'))).toBe(true)
    // the short remainder is dropped by default (ticked), the long one kept
    expect(boxes[0]).toContain('checked')
    expect(boxes[1]).not.toContain('checked')
    expect(html).toContain('ม้วน 50×30 มม.')
    expect(html).toContain('A4 24 ดวง (70×37 มม.)')
  })
  it('a flipped key shows the other tick state', () => {
    const boxes = checkboxes(render({ flipped: new Set(['A|F#1', 'A|F#2']) }))
    expect(boxes[0]).not.toContain('checked')
    expect(boxes[1]).toContain('checked')
  })
  it('after issue: only stocked remainders, with their code, ticks disabled and the PDF enabled', () => {
    const issued = { id: 'cp1', status: 'issued', signature: 'S', issued_at: '2026-10-27T03:00:00Z', plan }
    const html = render({ issued, codes: { 'A|F#2': 'OC-0012' } })
    expect(html).toContain('OC-0012')
    expect(html).not.toContain('OC-ใหม่')
    const boxes = checkboxes(html)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toContain('disabled')
    expect(html).not.toMatch(/disabled=""[^>]*>ดาวน์โหลด PDF สติกเกอร์/)
    expect(html).not.toContain('ยืนยันใบตัดก่อน')
  })
  it('after issue: a flip left over from before the issue does not grey out a stocked offcut', () => {
    const issued = { id: 'cp1', status: 'issued', signature: 'S', issued_at: '2026-10-27T03:00:00Z', plan }
    const html = render({ issued, codes: { 'A|F#2': 'OC-0012' }, flipped: new Set(['A|F#2']) })
    const boxes = checkboxes(html)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).not.toContain('checked')
    expect(html).not.toContain('opacity:0.35')
  })
  it('after issue but before the offcut codes load: PDF stays disabled', () => {
    const issued = { id: 'cp1', status: 'issued', signature: 'S', issued_at: '2026-10-27T03:00:00Z', plan }
    const html = render({ issued, codes: null })
    expect(html).toContain('กำลังโหลดรหัสเศษ...')
    expect(html).toMatch(/disabled=""[^>]*>ดาวน์โหลด PDF สติกเกอร์/)
  })
})

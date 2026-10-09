// Render smoke test for the send dialog (server-side render: no effects, clicks or Supabase).
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => n }))
const { default: SendToQuotationDialog, AcceptedConfirm } = await import('./SendToQuotationDialog.jsx')

const items = [{ id: 'a', opening_no: 'W-01', preview_svg_out: '<svg/>' }, { id: 'b', opening_no: 'W-02', preview_svg_out: null }, { id: 'c', opening_no: 'W-03' }]
const rows = [
  { id: 'a', resolved: true, price: 1000, quantity: 1 }, { id: 'b', resolved: true, price: 2000, quantity: 2 },
  { id: 'c', resolved: false, price: null, quantity: 1 },
]
const base = { project: { id: 'p1', description_format: ['item_name'] }, items, result: { rows, totals: {} }, descriptionCtxById: {}, link: null, snapshots: [], tenant: {}, onClose() {}, onDone() {}, clients: [{ id: 'c1', name: 'คุณวัฒน์' }] }
const html = p => renderToString(<SendToQuotationDialog {...base} {...p} />).replace(/<!-- -->/g, '')

describe('SendToQuotationDialog', () => {
  it('first send: submit disabled without a customer, label R1-1, no-preview warning', () => {
    const h = html({})
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>สร้างใบเสนอราคาร่าง/)
    expect(h).toContain('คุณวัฒน์')
    expect(h).toContain('R1-1')
    expect(h).toContain('ยังไม่ได้บันทึกภาพตัวอย่าง')
    expect(h).toContain('W-02')
  })
  it('blocks while an item is unresolved', () => {
    const h = html({})
    expect(h).toContain('มี 1 รายการที่คิดราคาไม่ได้')
    expect(h).toContain('ข้ามรายการที่คิดไม่ได้')
  })
  it('split text is inside a label bound to the checkbox, with a % box (default 80)', () => {
    const h = html({})
    expect(h).toMatch(/<label[^>]*><input type="checkbox"[^>]*\/>แยกค่าของ\/ค่าแรง<\/label>/)
    expect(h).toContain('value="80"')
  })
  it('the accepted confirm step is inline text with confirm and back buttons', () => {
    const h = renderToString(<AcceptedConfirm label="R3-1" busy={false} onConfirm={() => {}} onBack={() => {}} />)
    expect(h).toContain('ลูกค้ารับแล้ว'); expect(h).toContain('R3-1'); expect(h).toContain('ยืนยันอัปเดต')
  })
  it('shows the lock-date note, total before VAT and the isolation hint', () => {
    const h = html({ project: { ...base.project, price_as_of: '2026-10-09' } })
    expect(h).toContain('ราคาล็อกตามวันที่ราคาโปรเจกต์'); expect(h).toContain('2026-10-09')
    expect(h).toContain('รวม (ก่อน VAT)'); expect(h).toContain('เขียนลงเฉพาะใบเสนอราคาของโปรเจกต์นี้')
  })
  it('existing link with a last sent snapshot shows the old-vs-new comparison; a draft overwrite is labelled อัปเดตราคา', () => {
    const quotation = { id: 'q1', status: 'draft', revision: 1, pricing_mode: 'combined', clients: { name: 'x' } }
    const plan = { action: 'overwrite', bumpRevision: false, newRevision: 1, subNo: 2, needsAcceptedConfirm: false, updates: [{ openingId: 'a' }], inserts: [], deletes: [], keeps: [] }
    const snapshots = [{ kind: 'sent', quotation_id: 'q1', revision: 1, sub_no: 1, items: [{ opening_id: 'a', price: 900, quantity: 1 }] }]
    const h = html({ link: { quotation_id: 'q1' }, snapshots, preloaded: { quotation, plan } })
    expect(h).toContain('เปรียบเทียบกับที่ส่งล่าสุด'); expect(h).toContain('ราคาเดิม (R1-1)'); expect(h).toContain('ราคาใหม่ (R1-2)')
    expect(h).toContain('+100'); expect(h).toContain('+11.1%')
    expect(h).toMatch(/>อัปเดตราคา<\/button>/)
  })
  it('existing accepted quotation shows read-only customer, next label and no confirm() text before confirming', () => {
    const quotation = { id: 'q1', status: 'accepted', revision: 2, pricing_mode: 'combined', site_name: 'บ้านพี่วัฒน์', clients: { name: 'คุณวัฒน์' } }
    const plan = { action: 'pullback_overwrite', bumpRevision: true, newRevision: 3, subNo: 1, needsAcceptedConfirm: true, statusWarning: false, updates: [{ openingId: 'a' }], inserts: [], deletes: [], keeps: [] }
    const h = html({ link: { quotation_id: 'q1', attach_enabled: true }, preloaded: { quotation, plan } })
    expect(h).toContain('จะส่งเป็น <b>R3-1</b>')
    expect(h).toContain('ลูกค้ารับแล้ว')
    expect(h).toContain('ดึงกลับเป็นร่างและอัปเดตราคา')
    expect(h).not.toContain('— เลือกลูกค้า —')
    expect(h).toContain('บ้านพี่วัฒน์')
  })
})

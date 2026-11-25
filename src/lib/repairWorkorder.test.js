import { describe, it, expect } from 'vitest'
import { buildWorkOrder, thaiWeekday } from '../../supabase/functions/_shared/repair-workorder.ts'
import { itemsDescription } from '../../supabase/functions/_shared/repair-form.ts'

const base = (over = {}) => ({
  tenant: { company_name: 'บจก. ทดสอบ', address: '1 ถนนสุขุมวิท', phone: '02-111-2222', logo_url: 'https://x/logo.png' },
  ticket: {
    ticket_number: 'RP2611-001', created_at: '2026-11-24T18:30:00Z', source: 'line', description: null,
    scheduled_date: null, scheduled_start: null, duration_hours: null, preferred_days: null, preferred_slot: null,
  },
  site: { name: 'บ้านคุณสมใจ', location: '  99 ซอยสุข  ', map_url: null, lat: 13.7, lng: 100.5,
    handover_date: '2026-01-15', warranty_months: 12 },
  client: { name: 'สมใจ ใจดี', phone: '081-234-5678' },
  items: [],
  media: [],
  crew: [],
  receipt: null,
  today: '2026-11-25',
  ...over,
})

describe('buildWorkOrder header', () => {
  it('number, reported text from Bangkok date of created_at, company, site', () => {
    const w = buildWorkOrder(base())
    expect(w.number).toBe('RP2611-001')
    // 18:30Z on 24th = 01:30 on 25th in Bangkok
    expect(w.reportedText).toBe('แจ้งทาง LINE 25/11/2569')
    expect(w.company).toEqual({ name: 'บจก. ทดสอบ', address: '1 ถนนสุขุมวิท', phone: '02-111-2222', logoUrl: 'https://x/logo.png' })
    expect(w.siteName).toBe('บ้านคุณสมใจ')
    expect(w.address).toBe('99 ซอยสุข')
    expect(w.customerText).toBe('สมใจ ใจดี · 081-234-5678')
    expect(w.mapUrl).toBe('https://www.google.com/maps?q=13.7,100.5')
    expect(w.receipt).toBeNull()
  })

  it('staff source, missing company fields, no logo, no location, no phone', () => {
    const w = buildWorkOrder(base({
      tenant: {},
      ticket: { ...base().ticket, source: 'staff', created_at: '2026-11-25T03:00:00Z' },
      site: { ...base().site, location: null, lat: null, lng: null },
      client: { name: 'สมใจ', phone: null },
    }))
    expect(w.reportedText).toBe('แจ้งโดยทีมงาน 25/11/2569')
    expect(w.company).toEqual({ name: '', address: '', phone: '', logoUrl: null })
    expect(w.address).toBe('-')
    expect(w.mapUrl).toBeNull()
    expect(w.customerText).toBe('สมใจ')
  })

  it('client name printed as stored (no prefix); company name; no client -> "-"', () => {
    expect(buildWorkOrder(base({ client: { name: '  คุณสมใจ ', phone: null } })).customerText).toBe('คุณสมใจ')
    expect(buildWorkOrder(base({ client: { name: 'บจก. เอบีซี', phone: '02-111-2222' } })).customerText).toBe('บจก. เอบีซี · 02-111-2222')
    expect(buildWorkOrder(base({ client: null })).customerText).toBe('-')
  })

  it('passes the receipt through', () => {
    const receipt = { signer_name: 'สมใจ', signed_at: '2026-11-27T16:00:00Z', signature_url: 'https://x/s.png' }
    expect(buildWorkOrder(base({ receipt })).receipt).toEqual(receipt)
  })
})

describe('warranty badge', () => {
  it('active', () => {
    expect(buildWorkOrder(base()).warranty).toEqual({ kind: 'active', text: '✓ อยู่ในประกัน ถึง 15/01/2570 · ไม่เก็บเงิน' })
  })
  it('expired', () => {
    const w = buildWorkOrder(base({ site: { ...base().site, handover_date: '2024-01-15' } }))
    expect(w.warranty).toEqual({ kind: 'expired', text: '⚠️ นอกประกัน (หมด 15/01/2568) · ต้องมีใบเสนอราคาก่อน' })
  })
  it('none when warranty is 0 or null', () => {
    expect(buildWorkOrder(base({ site: { ...base().site, warranty_months: 0 } })).warranty)
      .toEqual({ kind: 'none', text: 'ไม่มีประกัน' })
    expect(buildWorkOrder(base({ site: { ...base().site, warranty_months: null } })).warranty.kind).toBe('none')
  })
  it('not handed over beats warranty 0; no site too', () => {
    const nh = { kind: 'not_handed_over', text: 'ยังไม่ส่งมอบงาน' }
    expect(buildWorkOrder(base({ site: { ...base().site, handover_date: null, warranty_months: 0 } })).warranty).toEqual(nh)
    expect(buildWorkOrder(base({ site: { ...base().site, handover_date: null } })).warranty).toEqual(nh)
    const w = buildWorkOrder(base({ site: null }))
    expect(w.warranty).toEqual(nh)
    expect(w.siteName).toBe('-')
    expect(w.address).toBe('-')
    expect(w.mapUrl).toBeNull()
  })
})

describe('appointment', () => {
  const sched = (d, s, h) => base({ ticket: { ...base().ticket, scheduled_date: d, scheduled_start: s, duration_hours: h } })
  it('full text', () => {
    // The brief's sample pairs 'พฤหัส' with 27/11/2569, but 2026-11-27 is a Friday; 2026-11-26 is the Thursday.
    expect(buildWorkOrder(sched('2026-11-26', '22:00:00', 3)).appointmentText).toBe('พฤหัส 26/11/2569 · 22:00 · ประมาณ 3 ชม.')
    expect(buildWorkOrder(sched('2026-11-27', '22:00:00', 3)).appointmentText).toBe('ศ 27/11/2569 · 22:00 · ประมาณ 3 ชม.')
  })
  it('HH:MM start, fractional hours', () => {
    expect(buildWorkOrder(sched('2026-11-26', '09:00', 1.5)).appointmentText).toBe('พฤหัส 26/11/2569 · 09:00 · ประมาณ 1.5 ชม.')
  })
  it('omits missing parts', () => {
    expect(buildWorkOrder(sched('2026-11-29', null, 0)).appointmentText).toBe('อา 29/11/2569')
    expect(buildWorkOrder(sched('2026-11-29', '08:30:00', null)).appointmentText).toBe('อา 29/11/2569 · 08:30')
  })
  it('null schedule -> null', () => {
    expect(buildWorkOrder(base()).appointmentText).toBeNull()
    expect(buildWorkOrder(sched(null, '22:00:00', 3)).appointmentText).toBeNull()
  })
  it('weekday names', () => {
    // 2026-11-22 is a Sunday
    const names = ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'].map(thaiWeekday)
    expect(names).toEqual(['อา', 'จ', 'อ', 'พ', 'พฤหัส', 'ศ', 'ส'])
  })
})

describe('crew', () => {
  it('leader first with (หัวหน้าทีม)', () => {
    const w = buildWorkOrder(base({ crew: [
      { name: 'สมชาย ช่างดี', nickname: null },
      { name: 'สมศักดิ์ ใจกล้า', nickname: 'ศักดิ์', is_team_leader: true },
      { name: 'สมปอง', nickname: '' },
    ] }))
    expect(w.crewText).toBe('สมศักดิ์ ใจกล้า (ศักดิ์) (หัวหน้าทีม), สมชาย ช่างดี, สมปอง')
  })
  it('empty -> "-"', () => {
    expect(buildWorkOrder(base()).crewText).toBe('-')
  })
})

describe('preferred', () => {
  it('days and night slot', () => {
    const w = buildWorkOrder(base({ ticket: { ...base().ticket, preferred_days: ['2026-11-27', '2026-11-29'], preferred_slot: 'night' } }))
    expect(w.preferredText).toBe('ลูกค้าสะดวก: 27/11/2569, 29/11/2569 · กลางคืน')
  })
  it('days without slot; none -> null', () => {
    expect(buildWorkOrder(base({ ticket: { ...base().ticket, preferred_days: ['2026-11-27'] } })).preferredText)
      .toBe('ลูกค้าสะดวก: 27/11/2569')
    expect(buildWorkOrder(base({ ticket: { ...base().ticket, preferred_days: [] } })).preferredText).toBeNull()
    expect(buildWorkOrder(base()).preferredText).toBeNull()
  })
})

describe('rows', () => {
  const items = [
    { id: 'i2', seq: 2, location: 'ครัว', room: null, symptom: 'รั่วซึม', note: null },
    { id: 'i1', seq: 1, location: 'ห้องนอน', room: 'ชั้น 2', symptom: 'อื่นๆ', note: 'บานเลื่อนฝืด' },
  ]
  const media = [
    { id: 'm1', item_id: 'i1', role: 'customer', media_type: 'image', url: 'https://x/1.jpg' },
    { id: 'm2', item_id: 'i2', role: 'customer', media_type: 'video', url: 'https://x/2.mp4' },
    { id: 'm3', item_id: 'i1', role: 'customer', media_type: 'image', url: null },
    { id: 'm4', item_id: 'i1', role: 'before', media_type: 'image', url: 'https://x/4.jpg' },
    { id: 'm5', item_id: null, role: 'customer', media_type: 'image', url: 'https://x/5.jpg' },
  ]
  it('sorted by seq, photos grouped by item_id, customer role only, video flag', () => {
    const w = buildWorkOrder(base({ items, media }))
    expect(w.rows).toEqual([
      { no: 1, where: 'ห้องนอน', room: 'ชั้น 2', symptom: 'อื่นๆ', note: 'บานเลื่อนฝืด',
        photos: [{ url: 'https://x/1.jpg', video: false }, { url: null, video: false }] },
      { no: 2, where: 'ครัว', room: '', symptom: 'รั่วซึม', note: '', photos: [{ url: 'https://x/2.mp4', video: true }] },
    ])
  })
  it('legacy ticket (no items) -> one row from description with all customer media', () => {
    const w = buildWorkOrder(base({ media, ticket: { ...base().ticket, description: '  หน้าต่างรั่ว\nตอนฝนตก  ' } }))
    expect(w.rows).toEqual([{ no: 1, where: 'ตามที่ลูกค้าแจ้ง', room: '', symptom: '', note: 'หน้าต่างรั่ว\nตอนฝนตก',
      photos: [
        { url: 'https://x/1.jpg', video: false }, { url: 'https://x/2.mp4', video: true },
        { url: null, video: false }, { url: 'https://x/5.jpg', video: false },
      ] }])
    expect(w.customerNote).toBeNull()
  })
  it('legacy with null description -> empty note', () => {
    expect(buildWorkOrder(base()).rows[0].note).toBe('')
  })
})

describe('customerNote', () => {
  const items = [
    { id: 'i1', seq: 1, location: 'ห้องนอน', room: 'ชั้น 2', symptom: 'อื่นๆ', note: 'บาน\nหมายเหตุ: ไม่ใช่โน้ตรวม' },
    { id: 'i2', seq: 2, location: 'ครัว', room: null, symptom: 'รั่วซึม', note: null },
  ]
  const desc = itemsDescription(items)
  const withDesc = (d) => base({ items, ticket: { ...base().ticket, description: d } })
  it('extracts the general note, even multi-line, ignoring a look-alike line inside an item note', () => {
    expect(buildWorkOrder(withDesc(`${desc}\nหมายเหตุ: มาหลัง 6 โมง\nกดกริ่งสองครั้ง`)).customerNote)
      .toBe('มาหลัง 6 โมง\nกดกริ่งสองครั้ง')
  })
  it('no note -> null', () => {
    expect(buildWorkOrder(withDesc(desc)).customerNote).toBeNull()
  })
  it('falls back to the first หมายเหตุ: line when description does not match the items', () => {
    expect(buildWorkOrder(withDesc('1. ห้องนอน — รั่วซึม\nหมายเหตุ: ด่วน')).customerNote).toBe('ด่วน')
  })
})

import { describe, it, expect } from 'vitest'
import {
  REPAIR_STATUS, REPAIR_STEPS, canMove, stepIndex, mediaTooBig, thaiWeekday, endTime,
  repairStartText, repairPickSiteText, repairReceivedText, repairCancelledText, repairTooBigText,
  repairNoTicketsText, scheduleText, reminderText, repairStatusFlex, repairReportFlex,
  repairMediaExt, repairMediaPath, quickReplyLabel, repairUploadMime, repairReceivedFlex, repairGotItText, repairScheduleFlex, repairReminderFlex,
  statusLabel, repairChooserText, repairAddStartText, repairAddNotFoundText, repairAddCancelledText, repairAddedText, repairAddedLine,
} from '../../supabase/functions/_shared/repair.ts'

const sched = {
  ticket_number: 'RP2610-001', site_name: 'บ้านคุณสมชาย', status: 'scheduled',
  scheduled_date: '2026-10-21', scheduled_start: '09:00:00', duration_hours: 1.5,
  created_at: '2026-10-19T03:00:00Z', handover_date: '2026-01-10', warranty_months: 12,
}

function walk(node, fn, path = '') {
  fn(node, path)
  if (Array.isArray(node)) node.forEach((c, i) => walk(c, fn, `${path}[${i}]`))
  else if (node && typeof node === 'object') Object.entries(node).forEach(([k, v]) => walk(v, fn, `${path}.${k}`))
}

const SIZES = ['xxs', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl', '3xl', '4xl', '5xl']
function checkFlex(msg) {
  expect(msg.type).toBe('flex')
  expect(Array.from(msg.altText).length).toBeLessThanOrEqual(400)
  expect(msg.altText.length).toBeGreaterThan(0)
  walk(msg.contents, (n) => {
    if (n === undefined) throw new Error('undefined node')
    if (n && typeof n === 'object' && !Array.isArray(n)) {
      if (n.type === 'text') {
        expect(typeof n.text).toBe('string')
        expect(n.text.length).toBeGreaterThan(0)
        expect(n.text).not.toContain('undefined')
        if (n.size) expect(SIZES).toContain(n.size)
      }
      if (n.type === 'box') {
        expect(n.layout).toBeTruthy()
        expect(Array.isArray(n.contents)).toBe(true)
      }
      if (n.type === 'button') {
        const label = n.action.label
        expect([...label].length).toBeLessThanOrEqual(20)
        expect(label.length).toBeLessThanOrEqual(20)
      }
      if (n.type === 'image') expect(n.url.startsWith('https://')).toBe(true)
    }
  })
}

describe('labels and rules', () => {
  it('labels', () => {
    expect(REPAIR_STATUS).toEqual({
      pending_review: 'รอพิจารณา', received: 'รับเรื่อง', scheduled: 'นัดเข้า',
      in_progress: 'กำลังซ่อม', done: 'เสร็จ', declined: 'ไม่รับ',
    })
    expect(REPAIR_STEPS).toEqual(['received', 'scheduled', 'in_progress', 'done'])
  })
  it('canMove allowed', () => {
    const ok = [['pending_review', 'received'], ['pending_review', 'declined'], ['received', 'scheduled'],
      ['received', 'declined'], ['scheduled', 'in_progress'], ['scheduled', 'received'],
      ['in_progress', 'done'], ['in_progress', 'scheduled'], ['done', 'in_progress']]
    for (const [a, b] of ok) expect(canMove(a, b), `${a}->${b}`).toBe(true)
  })
  it('canMove full matrix: everything else false', () => {
    const all = ['pending_review', 'received', 'scheduled', 'in_progress', 'done', 'declined']
    const ok = new Set(['pending_review>received', 'pending_review>declined', 'received>scheduled', 'received>declined',
      'scheduled>in_progress', 'scheduled>received', 'in_progress>done', 'in_progress>scheduled', 'done>in_progress'])
    let falses = 0
    for (const a of all) for (const b of all) {
      const exp = ok.has(`${a}>${b}`)
      expect(canMove(a, b), `${a}->${b}`).toBe(exp)
      if (!exp) falses++
    }
    expect(falses).toBeGreaterThanOrEqual(8)
    expect(canMove('bogus', 'received')).toBe(false)
    expect(canMove('declined', 'received')).toBe(false)
    expect(canMove('done', 'received')).toBe(false)
  })
  it('stepIndex', () => {
    expect(stepIndex('received')).toBe(0)
    expect(stepIndex('scheduled')).toBe(1)
    expect(stepIndex('in_progress')).toBe(2)
    expect(stepIndex('done')).toBe(3)
    expect(stepIndex('pending_review')).toBe(-1)
    expect(stepIndex('declined')).toBe(-1)
  })
  it('mediaTooBig boundary', () => {
    expect(mediaTooBig(50 * 1024 * 1024)).toBe(false)
    expect(mediaTooBig(50 * 1024 * 1024 + 1)).toBe(true)
    expect(mediaTooBig(0)).toBe(false)
  })
})

describe('date helpers', () => {
  it('weekday', () => {
    expect(thaiWeekday('2026-10-18')).toBe('อา.')
    expect(thaiWeekday('2026-10-19')).toBe('จ.')
    expect(thaiWeekday('2026-10-20')).toBe('อ.')
    expect(thaiWeekday('2026-10-21')).toBe('พ.')
    expect(thaiWeekday('2026-10-22')).toBe('พฤ.')
    expect(thaiWeekday('2026-10-23')).toBe('ศ.')
    expect(thaiWeekday('2026-10-24')).toBe('ส.')
  })
  it('end time', () => {
    expect(endTime('09:00', 1.5)).toBe('10:30')
    expect(endTime('09:00:00', 2)).toBe('11:00')
    expect(endTime('09:00', 0.33)).toBe('09:20')
    expect(endTime('23:00', 3)).toBe('23:59')
    expect(endTime(null, 2)).toBe('')
  })
})

describe('texts', () => {
  it('start and pick', () => {
    expect(repairStartText('บ้าน A')).toBe('แจ้งปัญหาของงาน บ้าน A ได้เลยครับ 🙏\nพิมพ์อาการ และส่งรูป / วิดีโอ / PDF ได้หลายอย่าง\nส่งครบแล้วกด "ส่งครบแล้ว" (หรือรอ 30 นาที ระบบจะรวมให้เอง)')
    expect(repairPickSiteText()).toBe('แจ้งซ่อมงานไหนครับ?')
  })
  it('received omits zero counts', () => {
    expect(repairReceivedText('RP2610-001', 'บ้าน A', { text: 1, image: 3, video: 0, file: 2 })).toBe(
      'รับเรื่องแล้วครับ เลขที่ RP2610-001\nบ้าน A · ข้อความ 1 · รูป 3 · PDF 2\nเจ้าหน้าที่จะตรวจสอบและแจ้งนัดหมายกลับในแชทนี้\nติดตามได้ที่ "สถานะแจ้งซ่อม"')
    expect(repairReceivedText('X', 'S', { text: 0, image: 0, video: 4, file: 0 })).toContain('\nS · วิดีโอ 4\n')
  })
  it('fixed texts', () => {
    expect(repairCancelledText()).toBe('ยกเลิกการแจ้งซ่อมแล้วครับ')
    expect(repairTooBigText()).toBe('ไฟล์ใหญ่เกินไป ส่งทางแชทให้เจ้าหน้าที่แทนได้ครับ')
    expect(repairNoTicketsText()).toBe('ยังไม่มีรายการแจ้งซ่อมครับ หากพบปัญหา กด "แจ้งซ่อม" ได้ตลอด')
  })
  it('schedule and reminder', () => {
    expect(scheduleText(sched)).toBe('📅 นัดเข้าซ่อม RP2610-001\nบ้านคุณสมชาย\nพ. 21/10/2569 09:00–10:30 (ประมาณ 1.5 ชม.)\nหากไม่สะดวก ตอบกลับในแชทนี้ได้เลยครับ')
    expect(reminderText(sched)).toBe('🔔 พรุ่งนี้ ทีมช่างจะเข้าซ่อมที่ บ้านคุณสมชาย\nพ. 21/10/2569 · 09:00–10:30\nรบกวนเตรียมพื้นที่หน้างานให้ด้วยนะครับ 🙏')
    expect(scheduleText({ ...sched, duration_hours: 2 })).toContain('09:00–11:00 (ประมาณ 2 ชม.)')
  })
})

describe('missing time', () => {
  it('no start time leaves out the range', () => {
    const t = { ...sched, scheduled_start: null }
    expect(scheduleText(t)).toBe('📅 นัดเข้าซ่อม RP2610-001\nบ้านคุณสมชาย\nพ. 21/10/2569\nหากไม่สะดวก ตอบกลับในแชทนี้ได้เลยครับ')
    expect(reminderText(t)).toBe('🔔 พรุ่งนี้ ทีมช่างจะเข้าซ่อมที่ บ้านคุณสมชาย\nพ. 21/10/2569\nรบกวนเตรียมพื้นที่หน้างานให้ด้วยนะครับ 🙏')
    checkFlex(repairStatusFlex([t], '2026-10-20'))
  })
  it('no duration leaves out end time and hours', () => {
    for (const d of [null, 0]) {
      const t = { ...sched, duration_hours: d }
      expect(scheduleText(t)).toContain('\nพ. 21/10/2569 09:00\n')
      expect(scheduleText(t)).not.toMatch(/–|ประมาณ/)
      expect(reminderText(t)).toContain('\nพ. 21/10/2569 · 09:00\n')
      expect(reminderText(t)).not.toContain('–')
      const s = JSON.stringify(repairStatusFlex([t], '2026-10-20').contents)
      expect(s).not.toMatch(/–|ประมาณ/)
    }
  })
})

describe('repairStatusFlex', () => {
  const today = '2026-10-20'
  it('empty gives the no-tickets text', () => {
    expect(repairStatusFlex([], today)).toEqual({ type: 'text', text: repairNoTicketsText() })
    expect(repairStatusFlex([{ ...sched, status: 'declined' }], today).type).toBe('text')
  })
  it('scheduled bubble content', () => {
    const m = repairStatusFlex([sched], today)
    checkFlex(m)
    const s = JSON.stringify(m.contents)
    expect(s).toContain('#2B6CB0')
    expect(s).toContain('พ. 21/10/2569')
    expect(s).toContain('09:00–10:30')
    expect(s).toContain('อยู่ในประกัน · ไม่มีค่าใช้จ่าย')
    expect(s).toContain('ติดต่อ / ขอเลื่อนนัด')
    expect(s).toContain('"text":"ติดต่อเรา"')
    for (const l of ['รับเรื่อง', 'นัดเข้า', 'กำลังซ่อม', 'เสร็จ']) expect(s).toContain(`"${l}"`)
  })
  it('stepper fills dots up to the step', () => {
    const dots = (m) => {
      const out = []
      walk(m.contents, (n) => { if (n && n.width === '12px' && n.height === '12px') out.push(n.backgroundColor) })
      return out
    }
    expect(dots(repairStatusFlex([sched], today))).toEqual(['#2B6CB0', '#2B6CB0', '#DDDDDD', '#DDDDDD'])
    expect(dots(repairStatusFlex([{ ...sched, status: 'pending_review' }], today))).toEqual(['#DDDDDD', '#DDDDDD', '#DDDDDD', '#DDDDDD'])
  })
  it('pending_review label and colour', () => {
    const m = repairStatusFlex([{ ...sched, status: 'pending_review', scheduled_date: null }], today)
    checkFlex(m)
    const s = JSON.stringify(m.contents)
    expect(s).toContain('รอเจ้าหน้าที่ตรวจสอบ')
    expect(s).toContain('#B7791F')
    expect(s).not.toContain('นัดเข้าซ่อม')
  })
  it('out of warranty text', () => {
    const s = JSON.stringify(repairStatusFlex([{ ...sched, handover_date: '2024-01-01' }], today).contents)
    expect(s).toContain('นอกระยะประกัน · เจ้าหน้าที่จะแจ้งค่าใช้จ่าย')
  })
  it('header colours', () => {
    const c = (status) => repairStatusFlex([{ ...sched, status, done_at: '2026-10-19T05:00:00Z' }], today).contents.contents[0].header.backgroundColor
    expect(c('received')).toBe('#B7791F')
    expect(c('scheduled')).toBe('#2B6CB0')
    expect(c('in_progress')).toBe('#6B46C1')
    expect(c('done')).toBe('#2F6B3F')
  })
  it('ordering: open first by date, then recent done; old done and declined dropped', () => {
    const t = (n, o) => ({ ...sched, ticket_number: n, scheduled_date: null, ...o })
    const m = repairStatusFlex([
      t('D-OLD', { status: 'done', done_at: '2026-09-01T05:00:00Z', created_at: '2026-08-01T00:00:00Z' }),
      t('D-NEW', { status: 'done', done_at: '2026-10-10T05:00:00Z', created_at: '2026-09-01T00:00:00Z' }),
      t('X', { status: 'declined' }),
      t('O2', { status: 'received', created_at: '2026-10-18T00:00:00Z' }),
      t('O1', { status: 'received', created_at: '2026-10-10T00:00:00Z' }),
    ], today)
    const nums = m.contents.contents.map((b) => b.header.contents[0].text)
    expect(nums).toEqual(['O1', 'O2', 'D-NEW'])
  })
  it('caps at 10 bubbles and altText at 400 code points', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...sched, ticket_number: `RP2610-${String(i).padStart(3, '0')}`, site_name: 'ไซต์งานชื่อยาวมากๆ '.repeat(3),
    }))
    const m = repairStatusFlex(many, today)
    checkFlex(m)
    expect(m.contents.contents.length).toBe(10)
    expect(Array.from(m.altText).length).toBeLessThanOrEqual(400)
  })
})

describe('repairReportFlex', () => {
  const t = {
    ticket_number: 'RP2610-001', site_name: 'บ้านคุณสมชาย', status: 'done',
    description: 'หน้าต่างปิดไม่สนิท', fix_note: 'ปรับบานและเปลี่ยนยาง', done_at: '2026-10-20T05:00:00Z',
  }
  it('full report', () => {
    const m = repairReportFlex(t, ['https://x.test/b.jpg'], ['https://x.test/a.jpg'], '2027-01-10')
    checkFlex(m)
    const s = JSON.stringify(m.contents)
    expect(s).toContain('ซ่อมเสร็จเรียบร้อย ✓')
    expect(s).toContain('#2F6B3F')
    for (const x of ['ปัญหา', 'หน้าต่างปิดไม่สนิท', 'แก้ไข', 'ปรับบานและเปลี่ยนยาง', 'ก่อน', 'หลัง', '#B04A38',
      '20/10/2569', 'ประกันยังเหลือถึง', '10/01/2570', 'ยังพบปัญหา? แจ้งซ่อม', '"text":"แจ้งซ่อม"']) expect(s).toContain(x)
    let imgs = 0
    walk(m.contents, (n) => { if (n && n.type === 'image') imgs++ })
    expect(imgs).toBe(2)
  })
  it('only an after image', () => {
    const m = repairReportFlex(t, [], ['https://x.test/a.jpg'], null)
    checkFlex(m)
    const s = JSON.stringify(m.contents)
    expect(s).toContain('"หลัง"')
    expect(s).not.toContain('"ก่อน"')
    expect(s).not.toContain('ประกันยังเหลือถึง')
    let imgs = 0
    walk(m.contents, (n) => { if (n && n.type === 'image') imgs++ })
    expect(imgs).toBe(1)
  })
  it('no images leaves out the image row', () => {
    const m = repairReportFlex(t, [], [], '2027-01-10')
    checkFlex(m)
    let imgs = 0
    walk(m.contents, (n) => { if (n && n.type === 'image') imgs++ })
    expect(imgs).toBe(0)
    expect(JSON.stringify(m.contents)).not.toContain('"ก่อน"')
    expect(JSON.stringify(m.contents)).not.toContain('"หลัง"')
  })
})

describe('repair media helpers', () => {
  it('ext from mime for images and videos', () => {
    expect(repairMediaExt('image/jpeg')).toBe('jpg')
    expect(repairMediaExt('image/png')).toBe('png')
    expect(repairMediaExt('video/mp4')).toBe('mp4')
    expect(repairMediaExt('video/quicktime')).toBe('mov')
    expect(repairMediaExt('application/pdf')).toBe('pdf')
    expect(repairMediaExt('image/jpeg; charset=binary')).toBe('jpg')
    expect(repairMediaExt('application/octet-stream')).toBe('bin')
    expect(repairMediaExt('')).toBe('bin')
  })
  it('ext from the file name for files, lowercased and safe', () => {
    expect(repairMediaExt('application/octet-stream', 'แบบ.PDF')).toBe('pdf')
    expect(repairMediaExt('application/pdf', 'scan.final.Docx')).toBe('docx')
    expect(repairMediaExt('application/pdf', 'noext')).toBe('pdf')
    expect(repairMediaExt('application/octet-stream', 'x.../../etc')).toBe('bin')
    expect(repairMediaExt('application/pdf', 'a.thisistoolongext')).toBe('pdf')
  })
  it('storage path is deterministic: tenant/ticket/messageId.ext', () => {
    expect(repairMediaPath('t1', 'k1', '5551234', 'jpg')).toBe('t1/k1/5551234.jpg')
    expect(repairMediaPath('t1', 'k1', '../x/9_%', 'jpg')).toBe('t1/k1/x9.jpg')
  })
  it('upload content-type: only image/*, video/* and pdf are kept', () => {
    expect(repairUploadMime('image/jpeg')).toBe('image/jpeg')
    expect(repairUploadMime('video/mp4')).toBe('video/mp4')
    expect(repairUploadMime('application/pdf')).toBe('application/pdf')
    expect(repairUploadMime('text/html')).toBe('application/octet-stream')
    expect(repairUploadMime('image/svg+xml')).toBe('application/octet-stream')
    expect(repairUploadMime('')).toBe('application/octet-stream')
  })
  it('quick-reply label keeps at most 20 characters', () => {
    expect(quickReplyLabel('งาน A')).toBe('งาน A')
    expect([...quickReplyLabel('โครงการบ้านพักอาศัยสองชั้นหลังที่ 0')].length).toBe(20)
    expect(quickReplyLabel('')).toBe('-')
    expect(quickReplyLabel('😀'.repeat(15)).length).toBeLessThanOrEqual(20)
    expect(quickReplyLabel('ก' + '😀'.repeat(15)).length).toBeLessThanOrEqual(20)
  })
})

describe('received card', () => {
  const counts = { text: 1, image: 2, video: 1, file: 1 }
  it('is a valid Flex bubble with the plain text as altText', () => {
    const m = repairReceivedFlex('RP2610-001', 'บ้านคุณสมชาย', counts)
    checkFlex(m)
    expect(m.altText).toBe(repairReceivedText('RP2610-001', 'บ้านคุณสมชาย', counts))
    expect(m.contents.type).toBe('bubble')
    const all = JSON.stringify(m.contents)
    for (const s of ['RP2610-001', 'บ้านคุณสมชาย', 'รอเจ้าหน้าที่ตรวจสอบ', 'รูป 2', 'วิดีโอ 1', 'ไฟล์ 1', 'ข้อความ 1']) expect(all).toContain(s)
  })
  it('leaves out zero counts and says so when nothing was attached', () => {
    const all = JSON.stringify(repairReceivedFlex('RP2610-002', 'งาน A', { image: 1 }).contents)
    expect(all).toContain('รูป 1')
    expect(all).not.toContain('วิดีโอ')
    expect(JSON.stringify(repairReceivedFlex('RP2610-003', 'งาน A', {}).contents)).toContain('ไม่มีไฟล์แนบ')
  })
  it('footer button opens สถานะแจ้งซ่อม', () => {
    const m = repairReceivedFlex('RP2610-001', 'งาน A', counts)
    const btn = m.contents.footer.contents[0]
    expect(btn.action).toEqual({ type: 'message', label: 'ดูสถานะแจ้งซ่อม', text: 'สถานะแจ้งซ่อม' })
  })
  it('got-it text', () => {
    expect(repairGotItText()).toBe('ได้รับแล้ว ✓ ส่งเพิ่มได้อีก หรือกด "ส่งครบแล้ว" เมื่อครบ')
  })
})

describe('appointment and reminder cards', () => {
  it('appointment card: valid, text fallback, date, time, contact button', () => {
    const m = repairScheduleFlex(sched)
    checkFlex(m)
    expect(m.altText).toBe(scheduleText(sched))
    const all = JSON.stringify(m.contents)
    for (const x of ['RP2610-001', 'นัดเข้าซ่อม', 'บ้านคุณสมชาย', 'พ. 21/10/2569', '09:00–10:30', 'ประมาณ 1.5 ชม.']) expect(all).toContain(x)
    expect(m.contents.footer.contents[0].action).toEqual({ type: 'message', label: 'ติดต่อ / ขอเลื่อนนัด', text: 'ติดต่อเรา' })
  })
  it('reminder card: valid, text fallback, says tomorrow', () => {
    const m = repairReminderFlex(sched)
    checkFlex(m)
    expect(m.altText).toBe(reminderText(sched))
    const all = JSON.stringify(m.contents)
    for (const x of ['พรุ่งนี้', 'บ้านคุณสมชาย', 'พ. 21/10/2569', '09:00–10:30', 'เตรียมพื้นที่']) expect(all).toContain(x)
  })
  it('missing start time: no time row, no dangling dash', () => {
    for (const f of [repairScheduleFlex, repairReminderFlex]) {
      const m = f({ ...sched, scheduled_start: null })
      checkFlex(m)
      expect(JSON.stringify(m.contents)).not.toMatch(/–|ประมาณ/)
    }
  })
})

describe('adding to an existing ticket', () => {
  const open = [
    { ticket_number: 'RP2610-003', site_name: 'บ้านคุณสมชาย', status: 'scheduled', scheduled_date: '2026-10-21' },
    { ticket_number: 'RP2610-002', site_name: 'บ้านคุณสมชาย', status: 'pending_review' },
    { ticket_number: 'RP2610-001', site_name: 'บ้านคุณสมชาย', status: 'in_progress' },
    { ticket_number: 'RP2609-009', site_name: 'บ้านคุณสมชาย', status: 'received' },
  ]
  it('chooser text: up to 3 tickets with status label and appointment date', () => {
    expect(repairChooserText('บ้านคุณสมชาย', open)).toBe(
      'งาน บ้านคุณสมชาย มีเรื่องแจ้งซ่อมที่ยังไม่เสร็จ\n'
      + 'RP2610-003 · นัดเข้า · นัด พ. 21/10/2569\n'
      + 'RP2610-002 · รอเจ้าหน้าที่ตรวจสอบ\n'
      + 'RP2610-001 · กำลังซ่อม\n'
      + 'เพิ่มรูปหรือรายละเอียดในเรื่องเดิม หรือแจ้งเรื่องใหม่ได้ครับ',
    )
  })
  it('chooser text: a scheduled ticket without a date shows no นัด part', () => {
    expect(repairChooserText('X', [{ ticket_number: 'RP1', status: 'scheduled', scheduled_date: null }])).toContain('RP1 · นัดเข้า\n')
  })
  it('statusLabel is exported and names pending_review for the customer', () => {
    expect(statusLabel('pending_review')).toBe('รอเจ้าหน้าที่ตรวจสอบ')
    expect(statusLabel('received')).toBe('รับเรื่อง')
  })
  it('fixed texts', () => {
    expect(repairAddStartText('RP2610-001', 'บ้าน A')).toBe('เพิ่มรูป วิดีโอ PDF หรือรายละเอียดในเรื่อง RP2610-001 (บ้าน A) ได้เลยครับ 🙏\nส่งครบแล้วกด "ส่งครบแล้ว"')
    expect(repairAddNotFoundText()).toBe('ไม่พบเรื่องนี้ หรือเรื่องนี้ปิดไปแล้วครับ')
    expect(repairAddCancelledText()).toBe('ยกเลิกข้อมูลที่เพิ่มแล้วครับ (เรื่องเดิมยังอยู่)')
  })
  it('added line carries the Bangkok date (พ.ศ.) and time', () => {
    // 2026-10-20 17:05 UTC = 21/10/2569 00:05 Bangkok
    expect(repairAddedLine('กระจกร้าวเพิ่ม', Date.parse('2026-10-20T17:05:00Z'))).toBe('เพิ่มเติม 21/10/2569 00:05: กระจกร้าวเพิ่ม')
  })
  it('added card: valid, own title, no stepper, plain-text altText', () => {
    const counts = { text: 1, image: 2 }
    const m = repairReceivedFlex('RP2610-001', 'บ้านคุณสมชาย', counts, { added: true })
    checkFlex(m)
    expect(m.altText).toBe(repairAddedText('RP2610-001', 'บ้านคุณสมชาย', counts))
    expect(m.altText).toBe('เพิ่มข้อมูลในเรื่องเดิมแล้ว ✓ เลขที่ RP2610-001\nบ้านคุณสมชาย · ข้อความ 1 · รูป 2\nเจ้าหน้าที่จะเห็นข้อมูลที่เพิ่มในเรื่องนี้')
    const all = JSON.stringify(m.contents)
    for (const x of ['เพิ่มข้อมูลในเรื่องเดิมแล้ว ✓', 'RP2610-001', 'บ้านคุณสมชาย', 'ข้อความ 1', 'รูป 2', 'เจ้าหน้าที่จะเห็นข้อมูลที่เพิ่มในเรื่องนี้']) expect(all).toContain(x)
    // No stepper: the step labels never appear, nor the new-report wording.
    for (const x of ['กำลังซ่อม', 'รอเจ้าหน้าที่ตรวจสอบ', 'ได้รับแจ้งซ่อมแล้ว']) expect(all).not.toContain(x)
  })
  it('added card with nothing added still renders', () => {
    const m = repairReceivedFlex('RP2610-001', 'งาน A', {}, { added: true })
    checkFlex(m)
  })
  it('received card without the option is unchanged', () => {
    expect(repairReceivedFlex('RP2610-001', 'งาน A', { image: 1 }, {})).toEqual(repairReceivedFlex('RP2610-001', 'งาน A', { image: 1 }))
  })
  it('status card: open tickets get a second add button, done tickets do not', () => {
    const tickets = [
      { ticket_number: 'RP2610-001', site_name: 'A', status: 'received', created_at: '2026-10-19T03:00:00Z' },
      { ticket_number: 'RP2610-002', site_name: 'A', status: 'done', done_at: '2026-10-19T03:00:00Z' },
    ]
    const m = repairStatusFlex(tickets, '2026-10-20')
    checkFlex(m)
    const [openB, doneB] = m.contents.contents
    expect(openB.footer.contents.map((b) => b.action)).toEqual([
      { type: 'message', label: 'ติดต่อ / ขอเลื่อนนัด', text: 'ติดต่อเรา' },
      { type: 'message', label: 'เพิ่มรูป/รายละเอียด', text: 'เพิ่มเรื่อง:RP2610-001' },
    ])
    expect(doneB.footer.contents.map((b) => b.action.text)).toEqual(['ติดต่อเรา'])
  })
  it.each(['pending_review', 'scheduled', 'in_progress'])('status card: %s also gets the add button', (status) => {
    const m = repairStatusFlex([{ ticket_number: 'RP9', site_name: 'A', status, scheduled_date: '2026-10-22' }], '2026-10-20')
    expect(m.contents.contents[0].footer.contents.map((b) => b.action.text)).toEqual(['ติดต่อเรา', 'เพิ่มเรื่อง:RP9'])
  })
})

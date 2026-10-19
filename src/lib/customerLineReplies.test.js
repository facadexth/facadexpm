import { describe, it, expect } from 'vitest'
import {
  inviteOkText, inviteInvalidText, notLinkedText, quoteText, repairTempText,
  repairStatusTempText, warrantyText, contactText, statusText,
} from '../../supabase/functions/_shared/customer-line-replies.ts'

const big = { name: 'บ้านคุณบิ๊ก', status: 'Ongoing', pct: 62, phases: ['ติดตั้งกระจก ชั้น 2'], endDate: '2026-11-15', handoverDate: null, warrantyMonths: 12 }

describe('static reply texts', () => {
  it('invite replies', () => {
    expect(inviteOkText('คุณบิ๊ก')).toBe('เชื่อมกับ คุณบิ๊ก เรียบร้อยครับ\nกดเมนู "สถานะงาน" เพื่อดูความคืบหน้าได้ตลอด')
    expect(inviteInvalidText()).toBe('รหัสนี้ใช้ไม่ได้หรือหมดอายุแล้ว กรุณาขอรหัสใหม่จากบริษัท')
    expect(notLinkedText()).toBe('ยังไม่มีงานที่เชื่อมกับไลน์นี้\nถ้าเป็นลูกค้าอยู่แล้ว ส่งรหัสเชิญ 6 ตัวที่ได้จากบริษัทมาได้เลย\nถ้าสนใจทำงานใหม่ กด "ขอใบเสนอราคา"')
  })
  it('quote, repair and repair-status replies', () => {
    expect(quoteText()).toBe('ขอบคุณที่สนใจครับ\nส่งแบบหรือรูปหน้างาน ขนาดคร่าวๆ ที่ตั้งหน้างาน และเบอร์โทรมาในแชทนี้ได้เลย\nเจ้าหน้าที่จะติดต่อกลับโดยเร็ว')
    expect(repairTempText()).toBe('พิมพ์อาการและส่งรูปมาในแชทนี้ได้เลยครับ\nเจ้าหน้าที่จะรับเรื่องและติดต่อกลับ')
    expect(repairStatusTempText()).toBe('ยังไม่มีรายการแจ้งซ่อมในระบบ\nถ้าแจ้งไว้ทางแชท เจ้าหน้าที่จะตอบในแชทนี้')
  })
  it('contact reply with and without phone and hours', () => {
    expect(contactText({ companyName: 'FacadeX', phone: '02-000-0000', hours: 'จันทร์–เสาร์ 08:00–17:00' }))
      .toBe('FacadeX\nโทร 02-000-0000\nเวลาทำการ จันทร์–เสาร์ 08:00–17:00\nหรือพิมพ์ในแชทนี้ได้เลย เจ้าหน้าที่จะตอบในเวลาทำการ')
    expect(contactText({ companyName: 'FacadeX', phone: null, hours: null }))
      .toBe('FacadeX\nหรือพิมพ์ในแชทนี้ได้เลย เจ้าหน้าที่จะตอบในเวลาทำการ')
  })
})

describe('warrantyText', () => {
  const today = '2026-10-19'
  const mk = (over) => ({ ...big, status: 'Completed', ...over })
  it('active, expired, not handed over and no-warranty lines', () => {
    const sites = [
      mk({ name: 'บ้านคุณบิ๊ก', handoverDate: '2026-10-19', warrantyMonths: 12 }),
      mk({ name: 'คอนโด A', handoverDate: '2025-10-14', warrantyMonths: 12 }),
      mk({ name: 'บ้าน B', status: 'Ongoing', handoverDate: null, warrantyMonths: 12 }),
      mk({ name: 'บ้าน C', handoverDate: '2026-01-01', warrantyMonths: 0 }),
    ]
    expect(warrantyText(sites, today)).toBe([
      'บ้านคุณบิ๊ก: ในประกัน ถึง 19/10/2570',
      'คอนโด A: หมดประกันแล้ว (14/10/2569)',
      'บ้าน B: ยังไม่ส่งมอบงาน ประกันเริ่มนับจากวันส่งมอบ',
      'บ้าน C: ไม่มีระยะประกัน',
    ].join('\n'))
  })
  it('months 0 says no warranty even when not handed over', () => {
    expect(warrantyText([mk({ name: 'บ้าน D', handoverDate: null, warrantyMonths: 0 })], today))
      .toBe('บ้าน D: ไม่มีระยะประกัน')
  })
  it('skips Cancelled sites', () => {
    expect(warrantyText([{ ...big, status: 'Cancelled' }], today)).toBe('ยังไม่มีงานในระบบ')
  })
  it('returns the empty text for no sites', () => {
    expect(warrantyText([], today)).toBe('ยังไม่มีงานในระบบ')
  })
  it('a reopened site (not Completed, handover date kept) is not handed over', () => {
    expect(warrantyText([mk({ name: 'บ้าน E', status: 'Ongoing', handoverDate: '2026-05-01', warrantyMonths: 12 })], today))
      .toBe('บ้าน E: ยังไม่ส่งมอบงาน ประกันเริ่มนับจากวันส่งมอบ')
    expect(warrantyText([mk({ name: 'บ้าน F', status: 'On Hold', handoverDate: '2026-05-01', warrantyMonths: 0 })], today))
      .toBe('บ้าน F: ไม่มีระยะประกัน')
  })
  it('lists at most 10 sites', () => {
    const sites = Array.from({ length: 12 }, (_, i) => mk({ name: `S${i + 1}`, handoverDate: '2026-10-19', warrantyMonths: 12 }))
    const lines = warrantyText(sites, today).split('\n')
    expect(lines.length).toBe(10)
    expect(lines[9]).toBe('S10: ในประกัน ถึง 19/10/2570')
  })
  it('cuts the text at 4,900 characters', () => {
    const sites = Array.from({ length: 10 }, (_, i) => mk({ name: `ไซต์ ${i} ${'ก'.repeat(1000)}`, handoverDate: '2026-10-19', warrantyMonths: 12 }))
    const text = warrantyText(sites, today)
    expect(text.length).toBe(4900)
    expect(text.startsWith('ไซต์ 0 ')).toBe(true)
  })
})

describe('statusText', () => {
  it('formats one active site', () => {
    expect(statusText([big], '2026-10-19'))
      .toBe('สถานะงาน · อัปเดต 19/10/2569\n\nบ้านคุณบิ๊ก\nความคืบหน้ารวม 62%\nกำลังทำ: ติดตั้งกระจก ชั้น 2\nกำหนดเสร็จ: 15/11/2569')
  })
  it('shows the no-progress line when pct is null, with no phases or end date', () => {
    expect(statusText([{ ...big, pct: null, phases: [], endDate: null }], '2026-10-19'))
      .toBe('สถานะงาน · อัปเดต 19/10/2569\n\nบ้านคุณบิ๊ก\nยังไม่มีข้อมูลความคืบหน้า')
  })
  it('returns the empty text when no site is Ongoing or On Hold', () => {
    expect(statusText([], '2026-10-19')).toBe('ยังไม่มีงานที่กำลังดำเนินการ')
    expect(statusText([{ ...big, status: 'Completed' }], '2026-10-19')).toBe('ยังไม่มีงานที่กำลังดำเนินการ')
  })
  it('separates several sites with a blank line and rounds pct', () => {
    const second = { ...big, name: 'คอนโด B', status: 'On Hold', pct: 33.5, phases: [], endDate: null }
    expect(statusText([big, second], '2026-10-19'))
      .toBe('สถานะงาน · อัปเดต 19/10/2569\n\nบ้านคุณบิ๊ก\nความคืบหน้ารวม 62%\nกำลังทำ: ติดตั้งกระจก ชั้น 2\nกำหนดเสร็จ: 15/11/2569\n\nคอนโด B\nความคืบหน้ารวม 34%')
  })
  it('lists at most 10 sites', () => {
    const sites = Array.from({ length: 12 }, (_, i) => ({ ...big, name: `S${i + 1}`, pct: 1, phases: [], endDate: null }))
    const blocks = statusText(sites, '2026-10-19').split('\n\n')
    expect(blocks.length).toBe(11) // header + 10 sites
    expect(blocks[10]).toBe('S10\nความคืบหน้ารวม 1%')
  })
  it('cuts the text at 4,900 characters', () => {
    const sites = Array.from({ length: 10 }, (_, i) => ({ ...big, name: `ไซต์ ${i}`, phases: ['ก'.repeat(1000)] }))
    const text = statusText(sites, '2026-10-19')
    expect(text.length).toBe(4900)
    expect(text.startsWith('สถานะงาน · อัปเดต 19/10/2569\n\nไซต์ 0\n')).toBe(true)
  })
})

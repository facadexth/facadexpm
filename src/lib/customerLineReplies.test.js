import { describe, it, expect } from 'vitest'
import {
  inviteOkText, inviteInvalidText, notLinkedText, quoteText, repairTempText,
  repairStatusTempText, warrantyTempText, contactText, statusText,
} from '../../supabase/functions/_shared/customer-line-replies.ts'

const big = { name: 'บ้านคุณบิ๊ก', status: 'Ongoing', pct: 62, phases: ['ติดตั้งกระจก ชั้น 2'], endDate: '2026-11-15' }

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

describe('warrantyTempText', () => {
  it('skips Cancelled sites and words Ongoing and Completed differently', () => {
    expect(warrantyTempText([big, { ...big, name: 'คอนโด A', status: 'Completed' }]))
      .toBe('บ้านคุณบิ๊ก: ยังไม่ส่งมอบงาน ประกันเริ่มนับจากวันส่งมอบ\nคอนโด A: ข้อมูลประกันกำลังจัดทำ สอบถามได้ที่แชทนี้')
    expect(warrantyTempText([{ ...big, status: 'Cancelled' }])).toBe('ยังไม่มีงานในระบบ')
  })
  it('returns the empty text for no sites', () => {
    expect(warrantyTempText([])).toBe('ยังไม่มีงานในระบบ')
  })
})

describe('statusText', () => {
  it('formats one active site', () => {
    expect(statusText([big], '2026-10-19'))
      .toBe('สถานะงาน · อัปเดต 19/10/2026\n\nบ้านคุณบิ๊ก\nความคืบหน้ารวม 62%\nกำลังทำ: ติดตั้งกระจก ชั้น 2\nกำหนดเสร็จ: 15/11/2026')
  })
  it('shows the no-progress line when pct is null, with no phases or end date', () => {
    expect(statusText([{ ...big, pct: null, phases: [], endDate: null }], '2026-10-19'))
      .toBe('สถานะงาน · อัปเดต 19/10/2026\n\nบ้านคุณบิ๊ก\nยังไม่มีข้อมูลความคืบหน้า')
  })
  it('returns the empty text when no site is Ongoing or On Hold', () => {
    expect(statusText([], '2026-10-19')).toBe('ยังไม่มีงานที่กำลังดำเนินการ')
    expect(statusText([{ ...big, status: 'Completed' }], '2026-10-19')).toBe('ยังไม่มีงานที่กำลังดำเนินการ')
  })
  it('separates several sites with a blank line and rounds pct', () => {
    const second = { ...big, name: 'คอนโด B', status: 'On Hold', pct: 33.5, phases: [], endDate: null }
    expect(statusText([big, second], '2026-10-19'))
      .toBe('สถานะงาน · อัปเดต 19/10/2026\n\nบ้านคุณบิ๊ก\nความคืบหน้ารวม 62%\nกำลังทำ: ติดตั้งกระจก ชั้น 2\nกำหนดเสร็จ: 15/11/2026\n\nคอนโด B\nความคืบหน้ารวม 34%')
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
    expect(text.startsWith('สถานะงาน · อัปเดต 19/10/2026\n\nไซต์ 0\n')).toBe(true)
  })
})

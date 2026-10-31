import { describe, it, expect } from 'vitest'
import {
  inviteOkText, inviteInvalidText, notLinkedText, quoteText,
  warrantyText, warrantyFlex, contactText, statusText,
} from '../../supabase/functions/_shared/customer-line-replies.ts'

const big = { name: 'บ้านคุณบิ๊ก', status: 'Ongoing', pct: 62, phases: [{ name: 'ติดตั้งกระจก ชั้น 2', start_date: null, end_date: null, status: 'in_progress' }], endDate: '2026-11-15', handoverDate: null, warrantyMonths: 12 }

describe('static reply texts', () => {
  it('invite replies', () => {
    expect(inviteOkText('คุณบิ๊ก')).toBe('เชื่อมกับ คุณบิ๊ก เรียบร้อยครับ\nกดเมนู "สถานะงาน" เพื่อดูความคืบหน้าได้ตลอด')
    expect(inviteInvalidText()).toBe('รหัสนี้ใช้ไม่ได้หรือหมดอายุแล้ว กรุณาขอรหัสใหม่จากบริษัท')
    expect(notLinkedText('แชงค์')).toBe('สวัสดีครับ ขอบคุณที่เพิ่มเพื่อน แชงค์ 🙏\n• เป็นลูกค้าของเราอยู่แล้ว: ส่งรหัสเชิญ 6 ตัวที่ได้จากเจ้าหน้าที่ เพื่อติดตามงานและประกันได้ทุกเมื่อ\n• สนใจงานหน้าต่าง ประตู กระจก อลูมิเนียม: กด "ขอใบเสนอราคา" ได้เลยครับ')
  })
  it('empty brand name leaves no double space', () => {
    expect(notLinkedText('').split('\n')[0]).toBe('สวัสดีครับ ขอบคุณที่เพิ่มเพื่อน 🙏')
    expect(statusText([], '2026-10-19', '').split('\n')[0]).toBe('ขอบคุณที่ไว้วางใจครับ 🙏')
    expect(notLinkedText('')).not.toContain('  ')
  })
  it('quote reply', () => {
    expect(quoteText()).toBe('ขอบคุณที่สนใจครับ\nส่งแบบหรือรูปหน้างาน ขนาดคร่าวๆ ที่ตั้งหน้างาน และเบอร์โทรมาในแชทนี้ได้เลย\nเจ้าหน้าที่จะติดต่อกลับโดยเร็ว')
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
  it('lists only in-progress phases as กำลังทำ', () => {
    const ph = (name, status) => ({ name, start_date: null, end_date: null, status })
    const s = { ...big, phases: [ph('วัด', 'done'), ph('ผลิต', 'in_progress'), ph('ติดตั้ง', 'not_started'), ph('VO ประตู', 'in_progress')] }
    expect(statusText([s], '2026-10-19', 'แชงค์')).toContain('กำลังทำ: ผลิต, VO ประตู\n')
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

const NO_ACTIVE = 'ขอบคุณที่ไว้วางใจ แชงค์ ครับ 🙏\nตอนนี้ยังไม่มีงานที่อยู่ระหว่างดำเนินการ\n• งานที่ส่งมอบแล้ว กด "ประกันของฉัน" เพื่อดูระยะประกันได้เลย\n• มีโครงการใหม่ กด "ขอใบเสนอราคา" ยินดีดูแลให้ครับ'

describe('statusText', () => {
  it('formats one active site', () => {
    expect(statusText([big], '2026-10-19', 'แชงค์'))
      .toBe('สถานะงาน · อัปเดต 19/10/2569\n\nบ้านคุณบิ๊ก\nความคืบหน้ารวม 62%\nกำลังทำ: ติดตั้งกระจก ชั้น 2\nกำหนดเสร็จ: 15/11/2569')
  })
  it('shows the no-progress line when pct is null, with no phases or end date', () => {
    expect(statusText([{ ...big, pct: null, phases: [], endDate: null }], '2026-10-19', 'แชงค์'))
      .toBe('สถานะงาน · อัปเดต 19/10/2569\n\nบ้านคุณบิ๊ก\nยังไม่มีข้อมูลความคืบหน้า')
  })
  it('returns the empty text when no site is Ongoing or On Hold', () => {
    expect(statusText([], '2026-10-19', 'แชงค์')).toBe(NO_ACTIVE)
    expect(statusText([{ ...big, status: 'Completed' }], '2026-10-19', 'แชงค์')).toBe(NO_ACTIVE)
  })
  it('separates several sites with a blank line and rounds pct', () => {
    const second = { ...big, name: 'คอนโด B', status: 'On Hold', pct: 33.5, phases: [], endDate: null }
    expect(statusText([big, second], '2026-10-19', 'แชงค์'))
      .toBe('สถานะงาน · อัปเดต 19/10/2569\n\nบ้านคุณบิ๊ก\nความคืบหน้ารวม 62%\nกำลังทำ: ติดตั้งกระจก ชั้น 2\nกำหนดเสร็จ: 15/11/2569\n\nคอนโด B\nความคืบหน้ารวม 34%')
  })
  it('lists at most 10 sites', () => {
    const sites = Array.from({ length: 12 }, (_, i) => ({ ...big, name: `S${i + 1}`, pct: 1, phases: [], endDate: null }))
    const blocks = statusText(sites, '2026-10-19', 'แชงค์').split('\n\n')
    expect(blocks.length).toBe(11) // header + 10 sites
    expect(blocks[10]).toBe('S10\nความคืบหน้ารวม 1%')
  })
  it('cuts the text at 4,900 characters', () => {
    const sites = Array.from({ length: 10 }, (_, i) => ({ ...big, name: `ไซต์ ${i}`, phases: [{ name: 'ก'.repeat(1000), start_date: null, end_date: null, status: 'in_progress' }] }))
    const text = statusText(sites, '2026-10-19', 'แชงค์')
    expect(text.length).toBe(4900)
    expect(text.startsWith('สถานะงาน · อัปเดต 19/10/2569\n\nไซต์ 0\n')).toBe(true)
  })
})

describe('warrantyFlex', () => {
  const today = '2026-10-19'
  const mk = (over) => ({ ...big, status: 'Completed', handoverDate: '2026-04-19', warrantyMonths: 12, ...over })
  const bubbles = (m) => m.contents.contents
  const walk = (v, fn, path = '') => {
    fn(v, path)
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, fn, `${path}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, fn, `${path}.${k}`)
  }
  const texts = (v) => { const out = []; walk(v, (n) => { if (n && n.type === 'text') out.push(n.text) }); return out }

  it('active site', () => {
    const m = warrantyFlex([mk()], today, 'แชงค์')
    expect(m.type).toBe('flex')
    expect(m.contents.type).toBe('carousel')
    const b = bubbles(m)[0]
    expect(b.header.backgroundColor).toBe('#2F6B3F')
    expect(texts(b.header)).toEqual(['การรับประกันผลงาน', 'อยู่ในประกัน'])
    const t = texts(b.body)
    expect(t).toContain('บ้านคุณบิ๊ก')
    expect(t).toContain('19/04/2569')
    expect(t).toContain('19/04/2570')
    expect(t).toContain('เหลือประมาณ 6 เดือน')
    expect(t).toContain('หากพบปัญหาในระยะประกัน แจ้งเราได้ทันที ทีมงานพร้อมดูแลครับ')
    const fill = JSON.stringify(b.body).match(/"width":"(\d+)%"/)
    expect(fill).not.toBeNull()
    expect(Number(fill[1])).toBe(50)
    expect(JSON.stringify(b.body)).toContain('#EFEAE3')
    const [a, c] = b.footer.contents
    expect(a.action).toEqual({ type: 'message', label: 'แจ้งซ่อม', text: 'แจ้งซ่อม' })
    expect(a.style).toBe('secondary')
    expect(a.color).toBe('#D4B596')
    expect(c.action).toEqual({ type: 'message', label: 'ติดต่อเรา', text: 'ติดต่อเรา' })
  })
  it('active with under 60 days left says days, and progress is at least 2%', () => {
    const m = warrantyFlex([mk({ handoverDate: '2025-11-19' })], today, 'x')
    expect(texts(bubbles(m)[0].body)).toContain('เหลืออีก 31 วัน')
    const m2 = warrantyFlex([mk({ handoverDate: '2026-10-19' })], today, 'x')
    expect(JSON.stringify(m2.contents)).toContain('"width":"2%"')
  })
  it('expired site', () => {
    const b = bubbles(warrantyFlex([mk({ handoverDate: '2024-01-10' })], today, 'x'))[0]
    expect(b.header.backgroundColor).toBe('#6B6660')
    expect(texts(b.header)).toContain('หมดประกันแล้ว')
    expect(texts(b.body)).toContain('ยังดูแลได้เสมอ แจ้งซ่อมเพื่อให้ทีมงานประเมินและเสนอราคาครับ')
    expect(JSON.stringify(b.body)).not.toContain('"width"')
  })
  it('not handed over (no date, or not Completed)', () => {
    for (const s of [mk({ handoverDate: null }), mk({ status: 'Ongoing' })]) {
      const b = bubbles(warrantyFlex([s], today, 'x'))[0]
      expect(b.header.backgroundColor).toBe('#B7791F')
      expect(texts(b.header)).toContain('ยังไม่ส่งมอบงาน')
      expect(texts(b.body)).toContain('ประกันเริ่มนับจากวันส่งมอบงานครับ')
      expect(texts(b.body)).not.toContain('ส่งมอบงาน')
    }
  })
  it('months 0', () => {
    const b = bubbles(warrantyFlex([mk({ warrantyMonths: 0 })], today, 'x'))[0]
    expect(b.header.backgroundColor).toBe('#6B6660')
    expect(texts(b.header)).toContain('ไม่มีระยะประกัน')
    expect(texts(b.body)).toContain('สอบถามรายละเอียดได้ที่แชทนี้ครับ')
  })
  it('skips Cancelled, caps at 10, keeps order', () => {
    const sites = [mk({ name: 'X', status: 'Cancelled' }), ...Array.from({ length: 12 }, (_, i) => mk({ name: `S${i}` }))]
    const bs = bubbles(warrantyFlex(sites, today, 'x'))
    expect(bs).toHaveLength(10)
    expect(texts(bs[0].body)[0]).toBe('S0')
  })
  it('empty list -> plain text', () => {
    expect(warrantyFlex([], today, 'x')).toEqual({ type: 'text', text: 'ยังไม่มีงานในระบบ' })
    expect(warrantyFlex([mk({ status: 'Cancelled' })], today, 'x')).toEqual({ type: 'text', text: 'ยังไม่มีงานในระบบ' })
  })
  it('altText is the plain text, at most 400 chars', () => {
    const long = 'ก'.repeat(80)
    const sites = Array.from({ length: 10 }, () => mk({ name: long }))
    const m = warrantyFlex(sites, today, 'x')
    expect(Array.from(m.altText).length).toBeLessThanOrEqual(400)
    const emoji = warrantyFlex(Array.from({ length: 10 }, () => mk({ name: '😀'.repeat(60) })), today, 'x')
    expect(emoji.altText).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(warrantyFlex([mk()], today, 'x').altText).toBe(warrantyText([mk()], today))
  })
  it('no empty text, no undefined, valid sizes, small', () => {
    const sites = [mk(), mk({ handoverDate: '2024-01-10' }), mk({ handoverDate: null }), mk({ warrantyMonths: 0 }), mk({ name: '' })]
    const m = warrantyFlex(sites, today, 'x')
    const ok = ['xs', 'sm', 'md', 'lg', 'xl']
    walk(m, (n, path) => {
      expect(n, path).not.toBeUndefined()
      if (n && typeof n === 'object' && n.type === 'text') {
        expect(typeof n.text, path).toBe('string')
        expect(n.text.length, path).toBeGreaterThan(0)
        if (n.size) expect(ok).toContain(n.size)
      }
    })
    for (const b of bubbles(m)) expect(JSON.stringify(b).length).toBeLessThan(30000)
  })
})

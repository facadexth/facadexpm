import { describe, it, expect, vi } from 'vitest'
import { handleCustomerEvent } from '../../supabase/functions/_shared/customer-line-handler.ts'
import {
  inviteOkText, inviteInvalidText, notLinkedText, quoteText, warrantyFlex, contactText, statusText,
} from '../../supabase/functions/_shared/customer-line-replies.ts'
import {
  repairStartText, repairPickSiteText, repairReceivedText, repairCancelledText, repairTooBigText,
  repairNoTicketsText, repairStatusFlex,
} from '../../supabase/functions/_shared/repair.ts'

const ctx = { tenantId: 't1', today: '2026-10-19' }
const txt = (text) => ({ type: 'message', replyToken: 'rt', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text } })
const T = (text) => ({ type: 'text', text })
const site = { name: 'งาน A', status: 'Ongoing', pct: 40, phases: ['ติดตั้ง'], endDate: '2026-12-01', handoverDate: null, warrantyMonths: 12 }
const contact = { companyName: 'บจก.', phone: '02', hours: '8-17', brandName: 'แชงค์' }

function deps(over = {}) {
  return {
    getAccount: vi.fn().mockResolvedValue(null),
    claimInvite: vi.fn().mockResolvedValue({ status: 'invalid', clientName: null }),
    getDisplayName: vi.fn().mockResolvedValue('คุณบิ๊ก'),
    loadSites: vi.fn().mockResolvedValue([site]),
    loadPhotos: vi.fn().mockResolvedValue([]),
    getContact: vi.fn().mockResolvedValue(contact),
    openRequest: vi.fn().mockResolvedValue(undefined),
    touchAccount: vi.fn().mockResolvedValue(undefined),
    claimWelcome: vi.fn().mockResolvedValue(true),
    getRepairSession: vi.fn().mockResolvedValue(null),
    listClientSites: vi.fn().mockResolvedValue([{ id: 's1', name: 'งาน A' }]),
    startRepair: vi.fn().mockResolvedValue({ ticketId: 'k1', siteName: 'งาน A' }),
    appendRepairText: vi.fn().mockResolvedValue(undefined),
    storeRepairMedia: vi.fn().mockResolvedValue('ok'),
    finishRepair: vi.fn().mockResolvedValue(null),
    cancelRepair: vi.fn().mockResolvedValue('cancelled'),
    listRepairTickets: vi.fn().mockResolvedValue([]),
    ...over,
  }
}
const linked = { clientId: 'c1', clientName: 'ลูกค้า' }

describe('handleCustomerEvent', () => {
  it.each(['group', 'room'])('%s source: no reply, no claim, no request', async (type) => {
    const d = deps({ claimInvite: vi.fn().mockResolvedValue({ status: 'ok', clientName: 'ลูกค้า' }) })
    for (const text of ['K7P2QM', 'ขอใบเสนอราคา', 'แจ้งซ่อม', 'สถานะงาน']) {
      const ev = { ...txt(text), source: { type, groupId: 'G1', roomId: 'R1', userId: 'U1' } }
      expect(await handleCustomerEvent(ev, ctx, d)).toEqual([])
    }
    expect(d.claimInvite).not.toHaveBeenCalled()
    expect(d.openRequest).not.toHaveBeenCalled()
    expect(d.getAccount).not.toHaveBeenCalled()
    expect(d.touchAccount).not.toHaveBeenCalled()
  })
  it('unlinked + code, claim ok', async () => {
    const d = deps({ claimInvite: vi.fn().mockResolvedValue({ status: 'ok', clientName: 'ลูกค้า' }) })
    expect(await handleCustomerEvent(txt('K7P2QM'), ctx, d)).toEqual([T(inviteOkText('ลูกค้า'))])
  })
  it('unlinked + code, claim invalid', async () => {
    expect(await handleCustomerEvent(txt('K7P2QM'), ctx, deps())).toEqual([T(inviteInvalidText())])
  })
  it('linked + THANKS invalid stays silent', async () => {
    const d = deps({ getAccount: vi.fn().mockResolvedValue(linked) })
    expect(await handleCustomerEvent(txt('THANKS'), ctx, d)).toEqual([])
  })
  it('linked + code ok re-links', async () => {
    const d = deps({ getAccount: vi.fn().mockResolvedValue(linked), claimInvite: vi.fn().mockResolvedValue({ status: 'ok', clientName: 'ใหม่' }) })
    expect(await handleCustomerEvent(txt('K7P2QM'), ctx, d)).toEqual([T(inviteOkText('ใหม่'))])
  })
  it.each(['สถานะงาน', 'แจ้งซ่อม', 'สถานะแจ้งซ่อม', 'ประกันของฉัน'])('unlinked + %s -> notLinked', async (c) => {
    const d = deps()
    expect(await handleCustomerEvent(txt(c), ctx, d)).toEqual([T(notLinkedText('แชงค์'))])
    expect(d.openRequest).not.toHaveBeenCalled()
  })
  it('unlinked quote opens request once', async () => {
    const d = deps()
    expect(await handleCustomerEvent(txt('ขอใบเสนอราคา'), ctx, d)).toEqual([T(quoteText())])
    expect(d.openRequest).toHaveBeenCalledTimes(1)
    expect(d.openRequest).toHaveBeenCalledWith('quote', 'U1', null, 'คุณบิ๊ก')
  })
  it('linked warranty', async () => {
    const d = deps({ getAccount: vi.fn().mockResolvedValue(linked) })
    expect(await handleCustomerEvent(txt('ประกันของฉัน'), ctx, d)).toEqual([warrantyFlex([site], ctx.today, 'แชงค์')])
  })
  it('linked status with photos', async () => {
    const d = deps({
      getAccount: vi.fn().mockResolvedValue(linked),
      loadPhotos: vi.fn().mockResolvedValue([{ url: 'https://x/1.jpg' }, { url: 'https://x/2.jpg' }]),
    })
    const r = await handleCustomerEvent(txt('สถานะงาน'), ctx, d)
    expect(r).toEqual([
      T(statusText([site], '2026-10-19', 'แชงค์')),
      { type: 'image', originalContentUrl: 'https://x/1.jpg', previewImageUrl: 'https://x/1.jpg' },
      { type: 'image', originalContentUrl: 'https://x/2.jpg', previewImageUrl: 'https://x/2.jpg' },
    ])
  })
  it('contact for anyone', async () => {
    expect(await handleCustomerEvent(txt('ติดต่อเรา'), ctx, deps())).toEqual([T(contactText(contact))])
  })
  it('linked chit-chat silent', async () => {
    const d = deps({ getAccount: vi.fn().mockResolvedValue(linked) })
    expect(await handleCustomerEvent(txt('สวัสดี'), ctx, d)).toEqual([])
  })
  it('non-text events silent', async () => {
    const d = deps({ getAccount: vi.fn().mockResolvedValue(linked) })
    expect(await handleCustomerEvent({ type: 'message', replyToken: 'r', source: { type: 'user', userId: 'U1' }, message: { type: 'image' } }, ctx, d)).toEqual([])
    expect(await handleCustomerEvent({ type: 'message', replyToken: 'r', source: { type: 'user', userId: 'U1' }, message: { type: 'sticker' } }, ctx, d)).toEqual([])
    expect(await handleCustomerEvent({ type: 'follow', replyToken: 'r', source: { type: 'user', userId: 'U1' } }, ctx, d)).toEqual([])
  })
  it('touches account on every text event when linked', async () => {
    const d = deps({ getAccount: vi.fn().mockResolvedValue(linked) })
    await handleCustomerEvent(txt('สวัสดี'), ctx, d)
    await handleCustomerEvent(txt('ติดต่อเรา'), ctx, d)
    expect(d.touchAccount).toHaveBeenCalledTimes(2)
  })
  it('does not touch when unlinked', async () => {
    const d = deps()
    await handleCustomerEvent(txt('สวัสดี'), ctx, d)
    expect(d.touchAccount).not.toHaveBeenCalled()
  })
  it('a throwing dep rejects (shell is the only catch)', async () => {
    const d = deps({ claimInvite: vi.fn().mockRejectedValue(new Error('23505')) })
    await expect(handleCustomerEvent(txt('K7P2QM'), ctx, d)).rejects.toThrow('23505')
  })
})

describe('welcome behaviours', () => {
  const follow = (source = { type: 'user', userId: 'U1' }) => ({ type: 'follow', replyToken: 'rt', source })
  it('follow from unlinked user: welcome, no claim', async () => {
    const d = deps()
    expect(await handleCustomerEvent(follow(), ctx, d)).toEqual([T(notLinkedText('แชงค์'))])
    expect(d.claimWelcome).not.toHaveBeenCalled()
  })
  it('follow from linked user: silent', async () => {
    const d = deps({ getAccount: vi.fn().mockResolvedValue(linked) })
    expect(await handleCustomerEvent(follow(), ctx, d)).toEqual([])
  })
  it('follow from a group: silent', async () => {
    expect(await handleCustomerEvent(follow({ type: 'group', groupId: 'G1', userId: 'U1' }), ctx, deps())).toEqual([])
  })
  it('unlinked chat, claim true: welcome', async () => {
    const d = deps()
    expect(await handleCustomerEvent(txt('สวัสดี'), ctx, d)).toEqual([T(notLinkedText('แชงค์'))])
    expect(d.claimWelcome).toHaveBeenCalledWith('U1')
  })
  it('unlinked chat, claim false: silent', async () => {
    const d = deps({ claimWelcome: vi.fn().mockResolvedValue(false) })
    expect(await handleCustomerEvent(txt('สวัสดี'), ctx, d)).toEqual([])
  })
  it('linked chat: silent, no claim', async () => {
    const d = deps({ getAccount: vi.fn().mockResolvedValue(linked) })
    expect(await handleCustomerEvent(txt('สวัสดี'), ctx, d)).toEqual([])
    expect(d.claimWelcome).not.toHaveBeenCalled()
  })
  it('unlinked code-like text takes the invite path, no claim', async () => {
    const d = deps()
    expect(await handleCustomerEvent(txt('K7P2QM'), ctx, d)).toEqual([T(inviteInvalidText())])
    expect(d.claimWelcome).not.toHaveBeenCalled()
  })
})

// ---- Repair intake (Task 3) ----
const NOW = Date.parse('2026-10-20T03:00:00Z')
const rctx = { tenantId: 't1', today: '2026-10-20', now: NOW }
const active = { ticketId: 'k1', siteName: 'งาน A', expiresAt: '2026-10-20T03:20:00Z' }
const expired = { ticketId: 'k1', siteName: 'งาน A', expiresAt: '2026-10-20T02:59:59Z' }
const media = (type, extra = {}) => ({ type: 'message', replyToken: 'rt', source: { type: 'user', userId: 'U1' }, message: { type, id: 'M1', ...extra } })
const redeliver = (ev) => ({ ...ev, deliveryContext: { isRedelivery: true } })
const qr = (label, text) => ({ type: 'action', action: { type: 'message', label, text } })
const startMsg = (name) => ({ type: 'text', text: repairStartText(name), quickReply: { items: [qr('ส่งครบแล้ว', 'ส่งครบแล้ว'), qr('ยกเลิก', 'ยกเลิก')] } })
const L = (over = {}) => deps({ getAccount: vi.fn().mockResolvedValue(linked), ...over })
const two = [{ id: 's1', name: 'บ้านคุณสมชาย' }, { id: 's2', name: 'คอนโดริมน้ำ' }]

describe('repair intake', () => {
  it('2 sites: pick-site quick replies, no ticket yet', async () => {
    const d = L({ listClientSites: vi.fn().mockResolvedValue(two) })
    expect(await handleCustomerEvent(txt('แจ้งซ่อม'), rctx, d)).toEqual([{
      type: 'text', text: repairPickSiteText(),
      quickReply: { items: [qr('บ้านคุณสมชาย', 'แจ้งซ่อม:บ้านคุณสมชาย'), qr('คอนโดริมน้ำ', 'แจ้งซ่อม:คอนโดริมน้ำ')] },
    }])
    expect(d.listClientSites).toHaveBeenCalledWith('c1')
    expect(d.startRepair).not.toHaveBeenCalled()
  })
  it('pick-site: long names are cut to 20 chars, at most 13 items', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, name: `โครงการบ้านพักอาศัยสองชั้นหลังที่ ${i}` }))
    const d = L({ listClientSites: vi.fn().mockResolvedValue(many) })
    const [m] = await handleCustomerEvent(txt('แจ้งซ่อม'), rctx, d)
    expect(m.quickReply.items).toHaveLength(13)
    for (const it of m.quickReply.items) expect([...it.action.label].length).toBeLessThanOrEqual(20)
    expect(m.quickReply.items[0].action.text).toBe('แจ้งซ่อม:โครงการบ้านพักอาศัยสองชั้นหลังที่ 0')
  })
  it('parses แจ้งซ่อม:<name> and starts on that site', async () => {
    const d = L({ listClientSites: vi.fn().mockResolvedValue(two), startRepair: vi.fn().mockResolvedValue({ ticketId: 'k9', siteName: 'คอนโดริมน้ำ' }) })
    expect(await handleCustomerEvent(txt('แจ้งซ่อม:คอนโดริมน้ำ'), rctx, d)).toEqual([startMsg('คอนโดริมน้ำ')])
    expect(d.startRepair).toHaveBeenCalledWith('c1', 's2', 'U1', 'คุณบิ๊ก')
  })
  it('แจ้งซ่อม:<name> that is not the client\'s site re-asks', async () => {
    const d = L({ listClientSites: vi.fn().mockResolvedValue(two) })
    const r = await handleCustomerEvent(txt('แจ้งซ่อม:บ้านคนอื่น'), rctx, d)
    expect(r[0].text).toBe(repairPickSiteText())
    expect(r[0].quickReply.items).toHaveLength(2)
    expect(d.startRepair).not.toHaveBeenCalled()
  })
  it('duplicate names: first match wins', async () => {
    const d = L({ listClientSites: vi.fn().mockResolvedValue([{ id: 'a', name: 'X' }, { id: 'b', name: 'X' }]) })
    await handleCustomerEvent(txt('แจ้งซ่อม:X'), rctx, d)
    expect(d.startRepair).toHaveBeenCalledWith('c1', 'a', 'U1', 'คุณบิ๊ก')
  })
  it('single site starts immediately', async () => {
    const d = L()
    expect(await handleCustomerEvent(txt('แจ้งซ่อม'), rctx, d)).toEqual([startMsg('งาน A')])
    expect(d.startRepair).toHaveBeenCalledWith('c1', 's1', 'U1', 'คุณบิ๊ก')
    expect(d.openRequest).not.toHaveBeenCalled()
  })
  it('no sites: contact text, no ticket', async () => {
    const d = L({ listClientSites: vi.fn().mockResolvedValue([]) })
    expect(await handleCustomerEvent(txt('แจ้งซ่อม'), rctx, d)).toEqual([T(contactText(contact))])
    expect(d.startRepair).not.toHaveBeenCalled()
  })
  it('start quick-reply labels fit LINE\'s 20-char limit', () => {
    for (const it of startMsg('x').quickReply.items) expect([...it.action.label].length).toBeLessThanOrEqual(20)
  })
  it('text during a session is appended, no reply', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    expect(await handleCustomerEvent(txt('กระจกร้าว'), rctx, d)).toEqual([])
    expect(d.appendRepairText).toHaveBeenCalledWith('k1', 'กระจกร้าว')
  })
  it('code-like text during a session is appended, not claimed', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    expect(await handleCustomerEvent(txt('THANKS'), rctx, d)).toEqual([])
    expect(d.appendRepairText).toHaveBeenCalledWith('k1', 'THANKS')
    expect(d.claimInvite).not.toHaveBeenCalled()
  })
  it.each(['image', 'video'])('%s during a session is stored, no reply', async (type) => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    expect(await handleCustomerEvent(media(type), rctx, d)).toEqual([])
    expect(d.storeRepairMedia).toHaveBeenCalledWith('k1', 'M1', type, undefined)
  })
  it('file during a session is stored with its name', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    expect(await handleCustomerEvent(media('file', { fileName: 'แบบ.pdf', fileSize: 1000 }), rctx, d)).toEqual([])
    expect(d.storeRepairMedia).toHaveBeenCalledWith('k1', 'M1', 'file', 'แบบ.pdf')
  })
  it('too big from the store -> one too-big reply', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active), storeRepairMedia: vi.fn().mockResolvedValue('too_big') })
    expect(await handleCustomerEvent(media('video'), rctx, d)).toEqual([T(repairTooBigText())])
  })
  it('file over 50 MB is refused before any download', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    expect(await handleCustomerEvent(media('file', { fileName: 'a.pdf', fileSize: 50 * 1024 * 1024 + 1 }), rctx, d)).toEqual([T(repairTooBigText())])
    expect(d.storeRepairMedia).not.toHaveBeenCalled()
  })
  it('store error -> silent', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active), storeRepairMedia: vi.fn().mockResolvedValue('error') })
    expect(await handleCustomerEvent(media('image'), rctx, d)).toEqual([])
  })
  it('media with no session: [] and no store call', async () => {
    const d = L()
    expect(await handleCustomerEvent(media('image'), rctx, d)).toEqual([])
    expect(d.storeRepairMedia).not.toHaveBeenCalled()
  })
  it('media with an expired session: [] and no store call', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(expired) })
    expect(await handleCustomerEvent(media('image'), rctx, d)).toEqual([])
    expect(d.storeRepairMedia).not.toHaveBeenCalled()
  })
  it('media from a group: [] and no lookups', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    const ev = { ...media('image'), source: { type: 'group', groupId: 'G1', userId: 'U1' } }
    expect(await handleCustomerEvent(ev, rctx, d)).toEqual([])
    expect(d.getRepairSession).not.toHaveBeenCalled()
    expect(d.storeRepairMedia).not.toHaveBeenCalled()
  })
  it.each(['audio', 'sticker', 'location'])('%s during a session is ignored', async (type) => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    expect(await handleCustomerEvent(media(type), rctx, d)).toEqual([])
    expect(d.storeRepairMedia).not.toHaveBeenCalled()
    expect(d.appendRepairText).not.toHaveBeenCalled()
  })
  it('text with an expired session is treated as no session', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(expired) })
    expect(await handleCustomerEvent(txt('กระจกร้าว'), rctx, d)).toEqual([])
    expect(d.appendRepairText).not.toHaveBeenCalled()
  })
  it('ส่งครบแล้ว -> summary', async () => {
    const counts = { text: 1, image: 2, video: 1 }
    const d = L({
      getRepairSession: vi.fn().mockResolvedValue(active),
      finishRepair: vi.fn().mockResolvedValue({ ticketNumber: 'RP2610-001', siteName: 'งาน A', counts }),
    })
    expect(await handleCustomerEvent(txt('ส่งครบแล้ว'), rctx, d)).toEqual([T(repairReceivedText('RP2610-001', 'งาน A', counts))])
    expect(d.finishRepair).toHaveBeenCalledWith('U1')
    expect(d.appendRepairText).not.toHaveBeenCalled()
  })
  it('ส่งครบแล้ว after expiry still finishes (late confirmation)', async () => {
    const d = L({
      getRepairSession: vi.fn().mockResolvedValue(expired),
      finishRepair: vi.fn().mockResolvedValue({ ticketNumber: 'RP2610-001', siteName: 'งาน A', counts: { image: 1 } }),
    })
    expect(await handleCustomerEvent(txt('ส่งครบแล้ว'), rctx, d)).toEqual([T(repairReceivedText('RP2610-001', 'งาน A', { image: 1 }))])
  })
  it('ส่งครบแล้ว with nothing to finish -> silent', async () => {
    const d = L()
    expect(await handleCustomerEvent(txt('ส่งครบแล้ว'), rctx, d)).toEqual([])
    expect(d.finishRepair).toHaveBeenCalledWith('U1')
  })
  it('ยกเลิก during a session cancels', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    expect(await handleCustomerEvent(txt('ยกเลิก'), rctx, d)).toEqual([T(repairCancelledText())])
    expect(d.cancelRepair).toHaveBeenCalledWith('U1')
    expect(d.appendRepairText).not.toHaveBeenCalled()
  })
  it('ยกเลิก after staff picked the ticket up -> received summary, not cancelled', async () => {
    const d = L({
      getRepairSession: vi.fn().mockResolvedValue(active),
      cancelRepair: vi.fn().mockResolvedValue('kept'),
      finishRepair: vi.fn().mockResolvedValue({ ticketNumber: 'RP2610-002', siteName: 'งาน A', counts: { image: 1 } }),
    })
    expect(await handleCustomerEvent(txt('ยกเลิก'), rctx, d)).toEqual([T(repairReceivedText('RP2610-002', 'งาน A', { image: 1 }))])
    expect(d.finishRepair).toHaveBeenCalledWith('U1')
  })
  it('redelivered text in a session: no append', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    expect(await handleCustomerEvent(redeliver(txt('กระจกร้าว')), rctx, d)).toEqual([])
    expect(d.appendRepairText).not.toHaveBeenCalled()
  })
  it('redelivered แจ้งซ่อม: no new ticket', async () => {
    const d = L()
    expect(await handleCustomerEvent(redeliver(txt('แจ้งซ่อม')), rctx, d)).toEqual([])
    expect(d.startRepair).not.toHaveBeenCalled()
  })
  it('redelivered แจ้งซ่อม:<name>: no new ticket', async () => {
    const d = L({ listClientSites: vi.fn().mockResolvedValue(two) })
    expect(await handleCustomerEvent(redeliver(txt('แจ้งซ่อม:คอนโดริมน้ำ')), rctx, d)).toEqual([])
    expect(d.startRepair).not.toHaveBeenCalled()
  })
  it('redelivered media is still stored (idempotent by path)', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    expect(await handleCustomerEvent(redeliver(media('image')), rctx, d)).toEqual([])
    expect(d.storeRepairMedia).toHaveBeenCalledWith('k1', 'M1', 'image', undefined)
  })
  it('pick-site skips a site whose action text would pass 300 chars', async () => {
    const long = { id: 'x', name: 'ก'.repeat(300) }
    const d = L({ listClientSites: vi.fn().mockResolvedValue([long, ...two]) })
    const [m] = await handleCustomerEvent(txt('แจ้งซ่อม'), rctx, d)
    expect(m.quickReply.items.map((i) => i.action.text)).toEqual(['แจ้งซ่อม:บ้านคุณสมชาย', 'แจ้งซ่อม:คอนโดริมน้ำ'])
    for (const i of m.quickReply.items) expect(i.action.text.length).toBeLessThanOrEqual(300)
  })
  it('ยกเลิก with no session is ordinary chat', async () => {
    const d = L()
    expect(await handleCustomerEvent(txt('ยกเลิก'), rctx, d)).toEqual([])
    expect(d.cancelRepair).not.toHaveBeenCalled()
  })
  it('a menu command during a session is answered and the session stays', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active) })
    expect(await handleCustomerEvent(txt('ติดต่อเรา'), rctx, d)).toEqual([T(contactText(contact))])
    expect(d.appendRepairText).not.toHaveBeenCalled()
    expect(d.finishRepair).not.toHaveBeenCalled()
    expect(d.cancelRepair).not.toHaveBeenCalled()
  })
  it('แจ้งซ่อม during a session repeats the start reply, no second ticket', async () => {
    const d = L({ getRepairSession: vi.fn().mockResolvedValue(active), listClientSites: vi.fn().mockResolvedValue(two) })
    expect(await handleCustomerEvent(txt('แจ้งซ่อม'), rctx, d)).toEqual([startMsg('งาน A')])
    expect(d.startRepair).not.toHaveBeenCalled()
  })
  it('unlinked แจ้งซ่อม:<name> -> notLinked', async () => {
    const d = deps()
    expect(await handleCustomerEvent(txt('แจ้งซ่อม:งาน A'), rctx, d)).toEqual([T(notLinkedText('แชงค์'))])
    expect(d.startRepair).not.toHaveBeenCalled()
  })
  it('unlinked ส่งครบแล้ว does not finish anything', async () => {
    const d = deps({ claimWelcome: vi.fn().mockResolvedValue(false) })
    expect(await handleCustomerEvent(txt('ส่งครบแล้ว'), rctx, d)).toEqual([])
    expect(d.finishRepair).not.toHaveBeenCalled()
    expect(d.getRepairSession).not.toHaveBeenCalled()
  })
  it('สถานะแจ้งซ่อม with tickets -> flex', async () => {
    const tickets = [{ ticket_number: 'RP2610-001', site_name: 'งาน A', status: 'received', created_at: '2026-10-19T03:00:00Z' }]
    const d = L({ listRepairTickets: vi.fn().mockResolvedValue(tickets) })
    expect(await handleCustomerEvent(txt('สถานะแจ้งซ่อม'), rctx, d)).toEqual([repairStatusFlex(tickets, '2026-10-20')])
    expect(d.listRepairTickets).toHaveBeenCalledWith('c1')
  })
  it('สถานะแจ้งซ่อม with none -> text', async () => {
    expect(await handleCustomerEvent(txt('สถานะแจ้งซ่อม'), rctx, L())).toEqual([T(repairNoTicketsText())])
  })
})

import { describe, it, expect, vi } from 'vitest'
import { handleCustomerEvent } from '../../supabase/functions/_shared/customer-line-handler.ts'
import {
  inviteOkText, inviteInvalidText, notLinkedText, quoteText, repairTempText,
  repairStatusTempText, warrantyText, contactText, statusText,
} from '../../supabase/functions/_shared/customer-line-replies.ts'

const ctx = { tenantId: 't1', today: '2026-10-19' }
const txt = (text) => ({ type: 'message', replyToken: 'rt', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text } })
const T = (text) => ({ type: 'text', text })
const site = { name: 'งาน A', status: 'Ongoing', pct: 40, phases: ['ติดตั้ง'], endDate: '2026-12-01', handoverDate: null, warrantyMonths: 12 }
const contact = { companyName: 'บจก.', phone: '02', hours: '8-17' }

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
    expect(await handleCustomerEvent(txt(c), ctx, d)).toEqual([T(notLinkedText())])
    expect(d.openRequest).not.toHaveBeenCalled()
  })
  it('unlinked quote opens request once', async () => {
    const d = deps()
    expect(await handleCustomerEvent(txt('ขอใบเสนอราคา'), ctx, d)).toEqual([T(quoteText())])
    expect(d.openRequest).toHaveBeenCalledTimes(1)
    expect(d.openRequest).toHaveBeenCalledWith('quote', 'U1', null, 'คุณบิ๊ก')
  })
  it('linked repair opens request', async () => {
    const d = deps({ getAccount: vi.fn().mockResolvedValue(linked) })
    expect(await handleCustomerEvent(txt('แจ้งซ่อม'), ctx, d)).toEqual([T(repairTempText())])
    expect(d.openRequest).toHaveBeenCalledWith('repair', 'U1', 'c1', 'คุณบิ๊ก')
  })
  it('linked repair_status and warranty', async () => {
    const d = deps({ getAccount: vi.fn().mockResolvedValue(linked) })
    expect(await handleCustomerEvent(txt('สถานะแจ้งซ่อม'), ctx, d)).toEqual([T(repairStatusTempText())])
    expect(await handleCustomerEvent(txt('ประกันของฉัน'), ctx, d)).toEqual([T(warrantyText([site], ctx.today))])
  })
  it('linked status with photos', async () => {
    const d = deps({
      getAccount: vi.fn().mockResolvedValue(linked),
      loadPhotos: vi.fn().mockResolvedValue([{ url: 'https://x/1.jpg' }, { url: 'https://x/2.jpg' }]),
    })
    const r = await handleCustomerEvent(txt('สถานะงาน'), ctx, d)
    expect(r).toEqual([
      T(statusText([site], '2026-10-19')),
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

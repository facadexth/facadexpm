// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'

const invoke = vi.fn()
const uploadToSignedUrl = vi.fn()
const resizeToJpeg = vi.fn()
vi.mock('./lib/supabase.js', () => ({
  supabase: {
    functions: { invoke: (...a) => invoke(...a) },
    storage: { from: () => ({ uploadToSignedUrl: (...a) => uploadToSignedUrl(...a) }) },
  },
}))
vi.mock('./lib/resizeImage.js', () => ({ resizeToJpeg: (...a) => resizeToJpeg(...a) }))

import SiteJobSheetPage from './SiteJobSheetPage.jsx'

const TASK = '11111111-1111-4111-8111-111111111111'
const BLOCKED = '22222222-2222-4222-8222-222222222222'
const card = (over) => ({
  id: TASK, name: 'ติดตั้งบานเลื่อน W1–W6', status: 'in_progress', statusText: 'กำลังทำ', qtyText: '-', ownersText: 'บอย',
  mine: true, canClose: true, blockedText: null, ...over,
})
const sheetOf = (over = {}) => ({
  dateText: 'พ. 26/11/2569',
  runText: 'วันที่ 3 จาก 5 · 24–28/11/2569',
  run: { index: 3, total: 5 },
  company: { name: 'บริษัท', address: '', phone: '', logoUrl: null },
  siteName: 'คอนโด The Line ห้อง 2104',
  address: '88 ถ.พระราม 9',
  mapUrl: 'https://maps.google.com/?q=1,2',
  leaderText: 'สมชาย · เช้า + บ่าย',
  crewText: 'บอย, ต้น',
  safetyNote: 'ใส่เข็มขัดนิรภัย',
  progressText: 'ติดตั้งบานกระจก · คืบหน้า 50%',
  problems: [{ id: 'p1', name: 'กระจกร้าว', zone: 'ชั้น 21' }],
  groups: [{
    phaseId: 'ph1', phase: 'ติดตั้งบานกระจก', zone: 'ชั้น 21',
    cards: [
      card(),
      card({ id: BLOCKED, name: 'ยิงซิลิโคน', qtyText: '4/6 บาน', mine: false, canClose: false, blockedText: 'การ์ดนี้นับจำนวน PM ปิดในเว็บ' }),
    ],
  }],
  cardCount: 2,
  drawings: [
    { id: 'd1', title: 'ผังชั้น 21', url: 'https://s/d1.png', mime: 'image/png' },
    { id: 'd2', title: 'แบบบาน W1', url: 'https://s/d2.pdf', mime: 'application/pdf' },
  ],
  viewerIsLeader: true,
  ...over,
})

let viewSheet
let cardReply
beforeEach(() => {
  cleanup()
  invoke.mockReset()
  uploadToSignedUrl.mockReset()
  resizeToJpeg.mockReset()
  viewSheet = sheetOf()
  cardReply = null
  let n = 0
  resizeToJpeg.mockImplementation(async () => new Blob(['x'.repeat(10)], { type: 'image/jpeg' }))
  uploadToSignedUrl.mockResolvedValue({ data: { path: 'p' }, error: null })
  invoke.mockImplementation(async (_n, { body }) => {
    if (body.action === 'view') return { data: { ok: true, sheet: viewSheet }, error: null }
    if (body.action === 'upload_url') {
      n++
      return { data: { path: `t/s/2026-11-26/js-tok-${n}.jpg`, signedUrl: 'https://u', uploadToken: `ut${n}` }, error: null }
    }
    if (body.action === 'card_update') {
      return { data: cardReply ?? { ok: true, sheet: sheetOf({ siteName: 'หลังบันทึก' }) }, error: null }
    }
    return { data: {}, error: null }
  })
})

const calls = (action) => invoke.mock.calls.filter((c) => c[1].body.action === action)
const file = () => new File(['img'], 'a.jpg', { type: 'image/jpeg' })
const pick = (n = 1) => {
  const input = screen.getByLabelText('เลือกจากเครื่อง')
  fireEvent.change(input, { target: { files: Array.from({ length: n }, file) } })
}
const sendBtn = () => screen.getByRole('button', { name: 'ส่ง' })

async function openCard(name) {
  render(<SiteJobSheetPage token="tok" />)
  fireEvent.click(await screen.findByText(name))
  return screen.getByRole('dialog')
}

describe('SiteJobSheetPage refusals', () => {
  const cases = [
    ['expired', 'ลิงก์หมดอายุ กด "งานวันนี้" ใน LINE อีกครั้ง'],
    ['not_found', 'ลิงก์หมดอายุ กด "งานวันนี้" ใน LINE อีกครั้ง'],
    ['not_assigned', 'วันนี้คุณไม่ได้อยู่ในทีมของไซท์นี้แล้ว'],
    ['line_bot_disabled', 'ใบงานออนไลน์ยังไม่เปิดใช้ ติดต่อแอดมิน'],
  ]
  for (const [reason, text] of cases) {
    it(`reason ${reason} shows its text and no sheet`, async () => {
      invoke.mockImplementation(async () => ({ data: { reason }, error: null }))
      render(<SiteJobSheetPage token="tok" />)
      expect(await screen.findByText(text)).toBeTruthy()
      expect(screen.queryByText('คอนโด The Line ห้อง 2104')).toBe(null)
    })
  }

  it('network failure shows the retry text; tapping it reloads', async () => {
    invoke.mockImplementationOnce(async () => { throw new Error('offline') })
    render(<SiteJobSheetPage token="tok" />)
    fireEvent.click(await screen.findByText('โหลดไม่สำเร็จ ลองใหม่'))
    expect(await screen.findByText('คอนโด The Line ห้อง 2104')).toBeTruthy()
  })

  it('a 500 also shows the retry text', async () => {
    invoke.mockImplementation(async () => ({ data: null, error: { context: { status: 500, json: async () => ({ error: 'failed' }) } } }))
    render(<SiteJobSheetPage token="tok" />)
    expect(await screen.findByText('โหลดไม่สำเร็จ ลองใหม่')).toBeTruthy()
  })
})

describe('SiteJobSheetPage view', () => {
  it('calls view with the token and renders header, run, problems, cards and drawings', async () => {
    const { container } = render(<SiteJobSheetPage token="tok" />)
    expect(await screen.findByText('คอนโด The Line ห้อง 2104')).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('site-jobsheet', { body: { token: 'tok', action: 'view' } })
    expect(screen.getByText('ใบงานติดตั้ง · พ. 26/11/2569')).toBeTruthy()
    expect(screen.getByText('วันที่ 3/5')).toBeTruthy()
    expect(container.querySelectorAll('.js-dots i').length).toBe(5)
    expect(container.querySelectorAll('.js-dots i.d').length).toBe(2)
    expect(screen.getByText('🗺️ แผนที่').getAttribute('href')).toBe('https://maps.google.com/?q=1,2')
    expect(screen.getByText(/ใส่เข็มขัดนิรภัย/)).toBeTruthy()
    expect(screen.getByText('ปัญหาที่ต้องแก้')).toBeTruthy()
    expect(screen.getByText('กระจกร้าว')).toBeTruthy()
    expect(screen.getAllByText('ของคุณ').length).toBe(1)
    expect(screen.getByText('4/6 บาน')).toBeTruthy()
    // image drawing: thumbnail + link; PDF: labelled tile, no <img>
    const img = screen.getByText('ผังชั้น 21').closest('a')
    expect(img.getAttribute('href')).toBe('https://s/d1.png')
    expect(img.getAttribute('target')).toBe('_blank')
    expect(img.querySelector('img').getAttribute('src')).toBe('https://s/d1.png')
    const pdf = screen.getByText('แบบบาน W1').closest('a')
    expect(pdf.getAttribute('href')).toBe('https://s/d2.pdf')
    expect(pdf.querySelector('img')).toBe(null)
    expect(within(pdf).getByText('PDF')).toBeTruthy()
  })

  it('non-leader: cards are not buttons, no sheet opens, shows the leader-only line', async () => {
    viewSheet = sheetOf({ viewerIsLeader: false })
    render(<SiteJobSheetPage token="tok" />)
    fireEvent.click(await screen.findByText('ติดตั้งบานเลื่อน W1–W6'))
    expect(screen.queryByRole('dialog')).toBe(null)
    expect(screen.getByText('เฉพาะหัวหน้าทีมกดอัปเดตการ์ดได้')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /ติดตั้งบานเลื่อน/ })).toBe(null)
    expect(screen.queryByText('⏳ ยังทำต่อพรุ่งนี้')).toBe(null)
  })

  it('a done card renders a ticked box (from status), open cards do not', async () => {
    viewSheet = sheetOf()
    viewSheet.groups[0].cards.push(card({ id: '33333333-3333-4333-8333-333333333333', name: 'เก็บงาน', status: 'done', statusText: 'เสร็จแล้ว', canClose: false }))
    const { container } = render(<SiteJobSheetPage token="tok" />)
    await screen.findByText('เก็บงาน')
    expect(container.querySelector('[data-card="33333333-3333-4333-8333-333333333333"] .js-box.done')).toBeTruthy()
    expect(container.querySelector(`[data-card="${TASK}"] .js-box.done`)).toBe(null)
    expect(container.querySelectorAll('.js-box.done').length).toBe(1)
  })

  it('problem cards are never tappable, even for the leader', async () => {
    render(<SiteJobSheetPage token="tok" />)
    fireEvent.click(await screen.findByText('กระจกร้าว'))
    expect(screen.queryByRole('dialog')).toBe(null)
  })
})

describe('SiteJobSheetPage leader card update', () => {
  it('done flow: send gated on mode + photo, posts taskId/mode/photos/note, shows saved + new sheet', async () => {
    const dlg = await openCard('ติดตั้งบานเลื่อน W1–W6')
    expect(within(dlg).getByText('จำนวน (PM กรอกในเว็บ)')).toBeTruthy()
    expect(sendBtn().disabled).toBe(true)
    fireEvent.click(within(dlg).getByRole('button', { name: '✅ เสร็จทั้งการ์ด' }))
    expect(sendBtn().disabled).toBe(true) // no photo yet
    pick(2)
    await waitFor(() => expect(sendBtn().disabled).toBe(false))
    expect(uploadToSignedUrl).toHaveBeenCalledTimes(2)
    const up = calls('upload_url')[0][1].body
    expect(up).toMatchObject({ token: 'tok', mime: 'image/jpeg', bytes: 10 })
    expect(uploadToSignedUrl.mock.calls[0][3]).toEqual({ contentType: 'image/jpeg' })
    fireEvent.change(within(dlg).getByLabelText('หมายเหตุ'), { target: { value: '  บาน W5 รางเบี้ยว ' } })
    fireEvent.click(sendBtn())
    await screen.findByText('บันทึกแล้ว')
    const body = calls('card_update')[0][1].body
    expect(body).toEqual({
      token: 'tok', action: 'card_update', taskId: TASK, mode: 'done',
      photos: ['t/s/2026-11-26/js-tok-1.jpg', 't/s/2026-11-26/js-tok-2.jpg'], note: 'บาน W5 รางเบี้ยว',
    })
    expect(screen.queryByRole('dialog')).toBe(null)
    expect(screen.getByText('หลังบันทึก')).toBeTruthy()
  })

  it('statusNote from a successful update shows under บันทึกแล้ว', async () => {
    cardReply = { ok: true, sheet: sheetOf(), statusNote: 'สถานะการ์ดไม่เปลี่ยน แจ้ง PM' }
    const dlg = await openCard('ติดตั้งบานเลื่อน W1–W6')
    fireEvent.click(within(dlg).getByRole('button', { name: '⏳ ยังทำต่อพรุ่งนี้' }))
    pick(1)
    await waitFor(() => expect(sendBtn().disabled).toBe(false))
    fireEvent.click(sendBtn())
    expect(await screen.findByText('บันทึกแล้ว')).toBeTruthy()
    expect(screen.getByText('สถานะการ์ดไม่เปลี่ยน แจ้ง PM')).toBeTruthy()
    expect(calls('card_update')[0][1].body.mode).toBe('continue')
  })

  it('blocked card: no done button, shows blockedText, continue still works', async () => {
    const dlg = await openCard('ยิงซิลิโคน')
    expect(within(dlg).queryByRole('button', { name: '✅ เสร็จทั้งการ์ด' })).toBe(null)
    expect(within(dlg).getByText('การ์ดนี้นับจำนวน PM ปิดในเว็บ')).toBeTruthy()
    expect(within(dlg).getByText('4/6 บาน')).toBeTruthy()
    fireEvent.click(within(dlg).getByRole('button', { name: '⏳ ยังทำต่อพรุ่งนี้' }))
    expect(sendBtn().disabled).toBe(true) // no photo
    pick(1)
    await waitFor(() => expect(sendBtn().disabled).toBe(false))
    fireEvent.click(sendBtn())
    await screen.findByText('บันทึกแล้ว')
    expect(calls('card_update')[0][1].body).toMatchObject({ taskId: BLOCKED, mode: 'continue' })
  })

  it('send stays disabled with a photo but no mode', async () => {
    await openCard('ติดตั้งบานเลื่อน W1–W6')
    pick(1)
    await waitFor(() => expect(uploadToSignedUrl).toHaveBeenCalled())
    expect(sendBtn().disabled).toBe(true)
  })

  it('server blocked reply shows its message in the sheet and keeps the photos', async () => {
    cardReply = { reason: 'blocked', message: 'ปิดการ์ดแม่ไม่ได้ ปิดการ์ดย่อยก่อน' }
    const dlg = await openCard('ติดตั้งบานเลื่อน W1–W6')
    fireEvent.click(within(dlg).getByRole('button', { name: '✅ เสร็จทั้งการ์ด' }))
    pick(1)
    await waitFor(() => expect(sendBtn().disabled).toBe(false))
    fireEvent.click(sendBtn())
    expect(await within(dlg).findByText('ปิดการ์ดแม่ไม่ได้ ปิดการ์ดย่อยก่อน')).toBeTruthy()
    expect(dlg.querySelectorAll('.js-ph').length).toBe(1)
    fireEvent.click(within(dlg).getByRole('button', { name: '⏳ ยังทำต่อพรุ่งนี้' }))
    expect(sendBtn().disabled).toBe(false)
  })

  for (const [reason, text] of [
    ['not_leader', 'เฉพาะหัวหน้าทีมกดอัปเดตการ์ดได้'],
    ['card_not_found', 'ไม่พบการ์ดนี้แล้ว ลองโหลดใหม่'],
  ]) {
    it(`card_update ${reason} shows its text in the sheet`, async () => {
      cardReply = { reason }
      const dlg = await openCard('ติดตั้งบานเลื่อน W1–W6')
      fireEvent.click(within(dlg).getByRole('button', { name: '⏳ ยังทำต่อพรุ่งนี้' }))
      pick(1)
      await waitFor(() => expect(sendBtn().disabled).toBe(false))
      fireEvent.click(sendBtn())
      expect(await within(dlg).findByText(text)).toBeTruthy()
    })
  }

  it('card_update not_assigned replaces the page with the refusal text', async () => {
    cardReply = { reason: 'not_assigned' }
    const dlg = await openCard('ติดตั้งบานเลื่อน W1–W6')
    fireEvent.click(within(dlg).getByRole('button', { name: '⏳ ยังทำต่อพรุ่งนี้' }))
    pick(1)
    await waitFor(() => expect(sendBtn().disabled).toBe(false))
    fireEvent.click(sendBtn())
    expect(await screen.findByText('วันนี้คุณไม่ได้อยู่ในทีมของไซท์นี้แล้ว')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBe(null)
  })

  it('caps photos at 10', async () => {
    const dlg = await openCard('ติดตั้งบานเลื่อน W1–W6')
    pick(12)
    expect(await within(dlg).findByText('รูปได้ไม่เกิน 10 รูป')).toBeTruthy()
    await waitFor(() => expect(uploadToSignedUrl).toHaveBeenCalledTimes(10))
    expect(calls('upload_url').length).toBe(10)
  })

  it('upload_url 429 too_many shows the daily-limit text', async () => {
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (n, arg) => (arg.body.action === 'upload_url'
      ? { data: null, error: { context: { status: 429, json: async () => ({ error: 'too_many' }) } } }
      : base(n, arg)))
    const dlg = await openCard('ติดตั้งบานเลื่อน W1–W6')
    pick(1)
    expect(await within(dlg).findByText('อัปโหลดรูปครบจำนวนของวันนี้แล้ว')).toBeTruthy()
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
    expect(dlg.querySelectorAll('.js-ph').length).toBe(0)
  })

  it('upload_url page-level reason (expired) replaces the page with the refusal text', async () => {
    const base = invoke.getMockImplementation()
    invoke.mockImplementation(async (n, arg) => (arg.body.action === 'upload_url' ? { data: { reason: 'expired' }, error: null } : base(n, arg)))
    await openCard('ติดตั้งบานเลื่อน W1–W6')
    pick(1)
    expect(await screen.findByText('ลิงก์หมดอายุ กด "งานวันนี้" ใน LINE อีกครั้ง')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBe(null)
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
  })

  it('a failed upload removes the tile and shows the upload error', async () => {
    uploadToSignedUrl.mockResolvedValue({ data: null, error: new Error('x') })
    const dlg = await openCard('ติดตั้งบานเลื่อน W1–W6')
    fireEvent.click(within(dlg).getByRole('button', { name: '⏳ ยังทำต่อพรุ่งนี้' }))
    pick(1)
    expect(await within(dlg).findByText('อัปโหลดรูปไม่สำเร็จ ลองใหม่')).toBeTruthy()
    expect(dlg.querySelectorAll('.js-ph').length).toBe(0)
    expect(sendBtn().disabled).toBe(true)
  })
})

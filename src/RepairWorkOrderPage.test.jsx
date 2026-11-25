// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const invoke = vi.fn()
vi.mock('./lib/supabase.js', () => ({ supabase: { functions: { invoke: (...a) => invoke(...a) } } }))
vi.mock('./components/SignaturePad.jsx', () => ({
  default: ({ onChange }) => <button type="button" onClick={() => onChange('data:image/png;base64,iVBORw0KGgo=')}>draw</button>,
}))
vi.mock('qrcode', () => ({ default: { toDataURL: async (u) => `data:image/png;base64,QR:${u}` } }))
vi.mock('./components/RepairWorkOrderSheet.jsx', () => ({
  default: ({ wo }) => <div data-testid="sheet">{wo.number}{wo.receipt ? ` signed:${wo.receipt.signer_name}` : ''}</div>,
}))

import RepairWorkOrderPage, { clientNameOf, laterText } from './RepairWorkOrderPage.jsx'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const wo = (receipt = null) => ({ number: 'RP2611-007', customerText: 'สมชาย ใจดี · 0812345678', receipt })

let signed
beforeEach(() => {
  cleanup()
  delete navigator.share
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true })
  invoke.mockReset()
  signed = null
  invoke.mockImplementation(async (_n, { body }) => {
    if (body.action === 'view') return { data: { ok: true, workOrder: wo(signed) }, error: null }
    if (body.action === 'sign') {
      signed = { signer_name: body.signerName, signed_at: '2026-11-25T03:00:00Z', signature_url: null }
      return { data: { ok: true, receipt: signed }, error: null }
    }
    return { data: { ok: true, sent: true, url: 'https://x/sign/1' }, error: null }
  })
})

const calls = (action) => invoke.mock.calls.filter((c) => c[1].body.action === action)

describe('RepairWorkOrderPage refusals', () => {
  const cases = [
    ['expired', 'ลิงก์หมดอายุ กด "งานวันนี้" ใน LINE อีกครั้ง'],
    ['not_found', 'ลิงก์หมดอายุ กด "งานวันนี้" ใน LINE อีกครั้ง'],
    ['not_assigned', 'คุณไม่ได้อยู่ในทีมของงานซ่อมนี้แล้ว'],
    ['declined', 'งานซ่อมนี้ถูกยกเลิกแล้ว'],
    ['line_bot_disabled', 'ใบงานซ่อมออนไลน์ยังไม่เปิดใช้ ติดต่อแอดมิน'],
  ]
  for (const [reason, text] of cases) {
    it(`reason ${reason} shows its text and no sheet`, async () => {
      invoke.mockImplementation(async () => ({ data: { reason }, error: null }))
      render(<RepairWorkOrderPage token="tok" />)
      expect(await screen.findByText(text)).toBeTruthy()
      expect(screen.queryByTestId('sheet')).toBe(null)
    })
  }

  it('network failure shows the retry text; tapping it reloads', async () => {
    invoke.mockImplementationOnce(async () => { throw new Error('offline') })
    render(<RepairWorkOrderPage token="tok" />)
    fireEvent.click(await screen.findByText('โหลดไม่สำเร็จ ลองใหม่'))
    expect(await screen.findByTestId('sheet')).toBeTruthy()
  })

  it('a 500 also shows the retry text', async () => {
    invoke.mockImplementation(async () => ({ data: null, error: { context: { status: 500, json: async () => ({ error: 'failed' }) } } }))
    render(<RepairWorkOrderPage token="tok" />)
    expect(await screen.findByText('โหลดไม่สำเร็จ ลองใหม่')).toBeTruthy()
  })
})

describe('RepairWorkOrderPage view + sign', () => {
  it('calls view with the token and shows the sheet and both buttons', async () => {
    render(<RepairWorkOrderPage token="tok" />)
    expect((await screen.findByTestId('sheet')).textContent).toBe('RP2611-007')
    expect(invoke).toHaveBeenCalledWith('repair-workorder', { body: { token: 'tok', action: 'view' } })
    expect(screen.getByRole('button', { name: '✍️ ให้ลูกค้าเซ็นรับงาน' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '🔗 ส่งลิงก์ให้ลูกค้าเซ็นทีหลัง' })).toBeTruthy()
  })

  it('sign flow: name prefilled, save gated on signature, posts signerName + png, refreshes view', async () => {
    render(<RepairWorkOrderPage token="tok" />)
    fireEvent.click(await screen.findByRole('button', { name: '✍️ ให้ลูกค้าเซ็นรับงาน' }))
    const name = screen.getByLabelText('ชื่อผู้เซ็น')
    expect(name.value).toBe('สมชาย ใจดี')
    const save = screen.getByRole('button', { name: 'บันทึกลายเซ็น' })
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'draw' }))
    expect(save.disabled).toBe(false)
    fireEvent.change(name, { target: { value: '' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(name, { target: { value: ' คุณเอ ' } })
    fireEvent.click(save)
    await waitFor(() => expect(calls('view').length).toBe(2))
    expect(calls('sign')[0][1].body).toEqual({ token: 'tok', action: 'sign', signerName: 'คุณเอ', signaturePng: PNG })
    expect((await screen.findByTestId('sheet')).textContent).toBe('RP2611-007 signed:คุณเอ')
    expect(screen.queryByRole('button', { name: 'บันทึกลายเซ็น' })).toBe(null)
    expect(screen.getByText('ลูกค้าเซ็นไปแล้ว: คุณเอ')).toBeTruthy()
  })

  it('client "-" prefills an empty name', () => {
    expect(clientNameOf({ customerText: '-' })).toBe('')
    expect(clientNameOf({ customerText: 'สมชาย' })).toBe('สมชาย')
    expect(clientNameOf({ customerText: '0812345678' })).toBe('0812345678')
  })

  it('already -> shows who signed, เซ็นใหม่แทน resends with force: true', async () => {
    let n = 0
    invoke.mockImplementation(async (_n, { body }) => {
      if (body.action === 'view') return { data: { ok: true, workOrder: wo(n > 1 ? { signer_name: 'B' } : null) }, error: null }
      n++
      if (!body.force) return { data: { ok: true, already: true, receipt: { id: 'r1', signer_name: 'คุณบี', signed_at: 'x' } }, error: null }
      return { data: { ok: true, receipt: { id: 'r2', signer_name: body.signerName, signed_at: 'y' } }, error: null }
    })
    render(<RepairWorkOrderPage token="tok" />)
    fireEvent.click(await screen.findByRole('button', { name: '✍️ ให้ลูกค้าเซ็นรับงาน' }))
    fireEvent.click(screen.getByRole('button', { name: 'draw' }))
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกลายเซ็น' }))
    expect(await screen.findByText('ลูกค้าเซ็นไปแล้ว: คุณบี')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'เซ็นใหม่แทน' }))
    await waitFor(() => expect(calls('view').length).toBe(2))
    const signs = calls('sign')
    expect(signs[0][1].body.force).toBeUndefined()
    expect(signs[1][1].body).toEqual({ token: 'tok', action: 'sign', signerName: 'สมชาย ใจดี', signaturePng: PNG, force: true })
  })

  it('existing receipt -> bar shows signer and เซ็นใหม่แทน opens the sheet that sends force', async () => {
    signed = { signer_name: 'คุณซี', signed_at: 'x', signature_url: null }
    render(<RepairWorkOrderPage token="tok" />)
    expect(await screen.findByText('ลูกค้าเซ็นไปแล้ว: คุณซี')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '✍️ ให้ลูกค้าเซ็นรับงาน' })).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: 'เซ็นใหม่แทน' }))
    fireEvent.click(screen.getByRole('button', { name: 'draw' }))
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกลายเซ็น' }))
    await waitFor(() => expect(calls('sign').length).toBe(1))
    expect(calls('sign')[0][1].body.force).toBe(true)
  })

  it('sign refusal shows the reason text in the sheet', async () => {
    invoke.mockImplementation(async (_n, { body }) => (body.action === 'view'
      ? { data: { ok: true, workOrder: wo() }, error: null }
      : { data: { reason: 'not_assigned' }, error: null }))
    render(<RepairWorkOrderPage token="tok" />)
    fireEvent.click(await screen.findByRole('button', { name: '✍️ ให้ลูกค้าเซ็นรับงาน' }))
    fireEvent.click(screen.getByRole('button', { name: 'draw' }))
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกลายเซ็น' }))
    expect(await screen.findByText('คุณไม่ได้อยู่ในทีมของงานซ่อมนี้แล้ว')).toBeTruthy()
  })
})

describe('RepairWorkOrderPage sign-later', () => {
  it('sent -> success text, button gone (one call only)', async () => {
    render(<RepairWorkOrderPage token="tok" />)
    fireEvent.click(await screen.findByRole('button', { name: '🔗 ส่งลิงก์ให้ลูกค้าเซ็นทีหลัง' }))
    expect(await screen.findByText('ส่งลิงก์ให้ลูกค้าทาง LINE แล้ว')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '🔗 ส่งลิงก์ให้ลูกค้าเซ็นทีหลัง' })).toBe(null)
    expect(calls('sign_link')[0][1].body).toEqual({ token: 'tok', action: 'sign_link' })
  })

  it('already signed -> shows who signed (not the not-sent text) and refreshes the view', async () => {
    let afterLink = false
    invoke.mockImplementation(async (_n, { body }) => {
      if (body.action === 'view') return { data: { ok: true, workOrder: wo(afterLink ? { signer_name: 'คุณดี' } : null) }, error: null }
      afterLink = true
      return { data: { ok: true, already: true, receipt: { id: 'r1', signer_name: 'คุณดี', signed_at: 'x' } }, error: null }
    })
    render(<RepairWorkOrderPage token="tok" />)
    fireEvent.click(await screen.findByRole('button', { name: '🔗 ส่งลิงก์ให้ลูกค้าเซ็นทีหลัง' }))
    await waitFor(() => expect(calls('view').length).toBe(2))
    expect((await screen.findAllByText('ลูกค้าเซ็นไปแล้ว: คุณดี')).length).toBeGreaterThan(0)
    expect(screen.queryByText('ส่งทาง LINE ไม่ได้ ให้ลูกค้าสแกนหรือส่งลิงก์นี้ให้ลูกค้าเอง')).toBe(null)
    expect((await screen.findByTestId('sheet')).textContent).toBe('RP2611-007 signed:คุณดี')
    expect(screen.queryByRole('button', { name: '🔗 ส่งลิงก์ให้ลูกค้าเซ็นทีหลัง' })).toBe(null)
  })

  const linkResult = (extra) => async (_n, { body }) => (body.action === 'view'
    ? { data: { ok: true, workOrder: wo() }, error: null }
    : { data: { ok: true, sent: false, url: 'https://x/sign/1', ...extra }, error: null })
  const NOT_SENT = 'ส่งทาง LINE ไม่ได้ ให้ลูกค้าสแกนหรือส่งลิงก์นี้ให้ลูกค้าเอง'

  async function tapLater() {
    render(<RepairWorkOrderPage token="tok" />)
    fireEvent.click(await screen.findByRole('button', { name: '🔗 ส่งลิงก์ให้ลูกค้าเซ็นทีหลัง' }))
  }

  it('sent -> no link box', async () => {
    await tapLater()
    await screen.findByText('ส่งลิงก์ให้ลูกค้าทาง LINE แล้ว')
    expect(screen.queryByLabelText('ลิงก์เซ็นรับงาน')).toBe(null)
    expect(screen.queryByRole('button', { name: 'คัดลอกลิงก์' })).toBe(null)
  })

  it('not sent (LINE refused) -> scan/share text + read-only link + QR + copy; no share without navigator.share', async () => {
    invoke.mockImplementation(linkResult({}))
    await tapLater()
    expect(await screen.findByText(NOT_SENT)).toBeTruthy()
    const box = screen.getByLabelText('ลิงก์เซ็นรับงาน')
    expect(box.value).toBe('https://x/sign/1')
    expect(box.readOnly).toBe(true)
    expect((await screen.findByAltText('QR ลิงก์เซ็นรับงาน')).getAttribute('src')).toBe('data:image/png;base64,QR:https://x/sign/1')
    expect(screen.getByRole('button', { name: 'คัดลอกลิงก์' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'แชร์' })).toBe(null)
    expect(calls('sign_link').length).toBe(1)
  })

  it('noLine -> same not-sent text and link', async () => {
    invoke.mockImplementation(linkResult({ noLine: true }))
    await tapLater()
    expect(await screen.findByText(NOT_SENT)).toBeTruthy()
    expect(screen.getByLabelText('ลิงก์เซ็นรับงาน').value).toBe('https://x/sign/1')
  })

  it('reused -> "sent a moment ago" text, link still shown', async () => {
    invoke.mockImplementation(linkResult({ reused: true }))
    await tapLater()
    expect(await screen.findByText('ส่งลิงก์ให้ลูกค้าไปแล้วเมื่อสักครู่')).toBeTruthy()
    expect(screen.queryByText(NOT_SENT)).toBe(null)
    expect(screen.getByLabelText('ลิงก์เซ็นรับงาน').value).toBe('https://x/sign/1')
  })

  it('capped -> cap text, link shown', async () => {
    invoke.mockImplementation(linkResult({ capped: true }))
    await tapLater()
    expect(await screen.findByText('ส่งลิงก์ครบ 3 ครั้งวันนี้แล้ว ใช้ลิงก์เดิมด้านล่าง')).toBeTruthy()
    expect(screen.getByLabelText('ลิงก์เซ็นรับงาน').value).toBe('https://x/sign/1')
  })

  it('laterText priority: capped > reused > not sent', () => {
    expect(laterText({ capped: true, reused: true })).toBe('ส่งลิงก์ครบ 3 ครั้งวันนี้แล้ว ใช้ลิงก์เดิมด้านล่าง')
    expect(laterText({ reused: true })).toBe('ส่งลิงก์ให้ลูกค้าไปแล้วเมื่อสักครู่')
    expect(laterText({ noLine: true })).toBe(NOT_SENT)
  })

  it('copy uses navigator.clipboard and says copied', async () => {
    const writeText = vi.fn(async () => {})
    navigator.clipboard = { writeText }
    invoke.mockImplementation(linkResult({}))
    await tapLater()
    fireEvent.click(await screen.findByRole('button', { name: 'คัดลอกลิงก์' }))
    expect(await screen.findByRole('button', { name: 'คัดลอกแล้ว' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith('https://x/sign/1')
  })

  it('copy without clipboard falls back to selecting the text', async () => {
    invoke.mockImplementation(linkResult({}))
    await tapLater()
    const box = await screen.findByLabelText('ลิงก์เซ็นรับงาน')
    fireEvent.click(screen.getByRole('button', { name: 'คัดลอกลิงก์' }))
    await waitFor(() => expect(document.activeElement).toBe(box))
    expect(box.selectionStart).toBe(0)
    expect(box.selectionEnd).toBe('https://x/sign/1'.length)
    expect(screen.queryByRole('button', { name: 'คัดลอกแล้ว' })).toBe(null)
  })

  it('share shown when navigator.share exists and passes the url', async () => {
    const share = vi.fn(async () => {})
    navigator.share = share
    invoke.mockImplementation(linkResult({}))
    await tapLater()
    fireEvent.click(await screen.findByRole('button', { name: 'แชร์' }))
    expect(share).toHaveBeenCalledWith({ url: 'https://x/sign/1' })
  })
})

describe('RepairWorkOrderPage sign already (F7)', () => {
  it('sign returns already -> page behind refreshes quietly (view called again, sheet shows signer)', async () => {
    let n = 0
    invoke.mockImplementation(async (_n, { body }) => {
      if (body.action === 'view') return { data: { ok: true, workOrder: wo(n > 0 ? { signer_name: 'คุณบี' } : null) }, error: null }
      n++
      return { data: { ok: true, already: true, receipt: { id: 'r1', signer_name: 'คุณบี', signed_at: 'x' } }, error: null }
    })
    render(<RepairWorkOrderPage token="tok" />)
    fireEvent.click(await screen.findByRole('button', { name: '✍️ ให้ลูกค้าเซ็นรับงาน' }))
    fireEvent.click(screen.getByRole('button', { name: 'draw' }))
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกลายเซ็น' }))
    await waitFor(() => expect(calls('view').length).toBe(2))
    expect((await screen.findByTestId('sheet')).textContent).toBe('RP2611-007 signed:คุณบี')
    // The sign sheet stays open so the crew can still choose เซ็นใหม่แทน.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByText('กำลังโหลด…')).toBe(null)
  })
})

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const invoke = vi.fn()
const uploadToSignedUrl = vi.fn()
vi.mock('./lib/supabase.js', () => ({
  supabase: {
    functions: { invoke: (...a) => invoke(...a) },
    storage: { from: () => ({ uploadToSignedUrl: (...a) => uploadToSignedUrl(...a) }) },
  },
}))
const readVideoSeconds = vi.fn()
vi.mock('./lib/videoDuration.js', () => ({ readVideoSeconds: (...a) => readVideoSeconds(...a) }))
const resizeToJpeg = vi.fn()
vi.mock('./lib/resizeImage.js', () => ({ resizeToJpeg: (...a) => resizeToJpeg(...a) }))

import RepairFormPage from './RepairFormPage.jsx'

const site = { id: 's1', name: 'บ้านคุณสมชาย' }
const info = { ok: true, clientName: 'สมชาย', brandName: 'FacadeX', sites: [site], bounds: { min: '2026-11-26', max: '2027-01-24' } }

let submitReply
beforeEach(() => {
  cleanup()
  try { localStorage.clear() } catch { /* none */ }
  invoke.mockReset()
  uploadToSignedUrl.mockReset()
  readVideoSeconds.mockReset()
  resizeToJpeg.mockReset()
  resizeToJpeg.mockResolvedValue(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }))
  submitReply = { data: { ok: true, ticketNumber: 'RP2611-007' }, error: null }
  invoke.mockImplementation(async (_n, { body }) => {
    if (body.action === 'info') return { data: info, error: null }
    if (body.action === 'upload_url') return { data: { path: `tenant/form-x/1.${body.mime === 'image/jpeg' ? 'jpg' : 'mp4'}`, signedUrl: 'https://x', uploadToken: 'up' }, error: null }
    return submitReply
  })
  uploadToSignedUrl.mockResolvedValue({ data: { path: 'p' }, error: null })
})

const calls = (action) => invoke.mock.calls.filter((c) => c[1].body.action === action)

async function fillOneItemAndGoToConfirm() {
  render(<RepairFormPage token="tok" />)
  fireEvent.click(await screen.findByRole('button', { name: 'ห้องนอน' }))
  fireEvent.click(screen.getByRole('button', { name: 'รั่วซึม' }))
  const cam = document.querySelector('input[accept="image/*"][capture="environment"]')
  fireEvent.change(cam, { target: { files: [new File(['raw'], 'a.jpg', { type: 'image/jpeg' })] } })
  const confirmBtn = screen.getByRole('button', { name: /ยืนยันรายการนี้/ })
  await waitFor(() => expect(confirmBtn.disabled).toBe(false))
  fireEvent.click(confirmBtn)
  fireEvent.click(await screen.findByRole('button', { name: /ไปหน้ายืนยัน/ }))
  return screen.findByRole('button', { name: /ส่งแจ้งซ่อม/ })
}

describe('RepairFormPage', () => {
  it('shows the expired message for reason expired', async () => {
    invoke.mockImplementation(async () => ({ data: { reason: 'expired' }, error: null }))
    render(<RepairFormPage token="tok" />)
    expect(await screen.findByText(/ลิงก์หมดอายุ/)).toBeTruthy()
  })

  it('shows the used message with the ticket number', async () => {
    invoke.mockImplementation(async () => ({ data: { reason: 'used', ticketNumber: 'RP2611-003' }, error: null }))
    render(<RepairFormPage token="tok" />)
    expect(await screen.findByText('ส่งเรื่องนี้แล้ว เลขที่ RP2611-003')).toBeTruthy()
  })

  it('shows the no-sites message', async () => {
    invoke.mockImplementation(async () => ({ data: { reason: 'no_sites' }, error: null }))
    render(<RepairFormPage token="tok" />)
    expect(await screen.findByText('ยังไม่พบไซท์ของคุณ กรุณาติดต่อบริษัท')).toBeTruthy()
  })

  it('with one site the first screen shows the location chips', async () => {
    render(<RepairFormPage token="tok" />)
    expect(await screen.findByRole('button', { name: 'ห้องนอน' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ภายนอก' })).toBeTruthy()
    expect(screen.queryByText('แจ้งซ่อมงานไหนครับ')).toBe(null)
  })

  it('with two sites the first screen asks which site', async () => {
    invoke.mockImplementation(async () => ({ data: { ...info, sites: [site, { id: 's2', name: 'อาคาร ABC' }] }, error: null }))
    render(<RepairFormPage token="tok" />)
    expect(await screen.findByText('แจ้งซ่อมงานไหนครับ')).toBeTruthy()
  })

  it('rejects a 31 s video before asking for an upload url', async () => {
    readVideoSeconds.mockResolvedValue(31)
    render(<RepairFormPage token="tok" />)
    await screen.findByRole('button', { name: 'ห้องนอน' })
    const vid = document.querySelector('input[accept="video/*"]')
    expect(vid.hasAttribute('capture')).toBe(true)
    fireEvent.change(vid, { target: { files: [new File(['v'], 'a.mp4', { type: 'video/mp4' })] } })
    expect(await screen.findByText('วิดีโอยาวได้ไม่เกิน 30 วินาที')).toBeTruthy()
    expect(calls('upload_url').length).toBe(0)
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
  })

  it('resize fails on a HEIC photo: shows the retake message and asks for no upload url', async () => {
    resizeToJpeg.mockRejectedValue(new Error('cannot decode'))
    render(<RepairFormPage token="tok" />)
    await screen.findByRole('button', { name: 'ห้องนอน' })
    const cam = document.querySelector('input[accept="image/*"][capture="environment"]')
    fireEvent.change(cam, { target: { files: [new File(['heic'], 'a.heic', { type: 'image/heic' })] } })
    expect(await screen.findByText('ไฟล์รูปนี้เปิดไม่ได้ ลองถ่ายใหม่')).toBeTruthy()
    expect(calls('upload_url').length).toBe(0)
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
  })

  it('resize fails on a JPEG photo: uploads the original file', async () => {
    resizeToJpeg.mockRejectedValue(new Error('cannot decode'))
    render(<RepairFormPage token="tok" />)
    await screen.findByRole('button', { name: 'ห้องนอน' })
    const original = new File(['original-jpeg'], 'a.jpg', { type: 'image/jpeg' })
    const cam = document.querySelector('input[accept="image/*"][capture="environment"]')
    fireEvent.change(cam, { target: { files: [original] } })
    await waitFor(() => expect(uploadToSignedUrl).toHaveBeenCalled())
    expect(calls('upload_url')[0][1].body).toEqual({ action: 'upload_url', token: 'tok', mime: 'image/jpeg', mediaType: 'image', bytes: original.size })
    expect(uploadToSignedUrl.mock.calls[0][2]).toBe(original)
    expect(uploadToSignedUrl.mock.calls[0][3]).toEqual({ contentType: 'image/jpeg' })
  })

  it('a submit answered ok shows the done screen with the ticket number and the exact payload', async () => {
    const send = await fillOneItemAndGoToConfirm()
    fireEvent.click(send)
    expect(await screen.findByText('รับเรื่องแล้ว เลขที่ RP2611-007')).toBeTruthy()
    const up = calls('upload_url')[0][1].body
    expect(up).toEqual({ action: 'upload_url', token: 'tok', mime: 'image/jpeg', mediaType: 'image', bytes: 10 })
    expect(uploadToSignedUrl.mock.calls[0][0]).toBe('tenant/form-x/1.jpg')
    expect(uploadToSignedUrl.mock.calls[0][1]).toBe('up')
    const body = calls('submit')[0][1].body
    expect(body).toEqual({
      action: 'submit',
      token: 'tok',
      payload: {
        siteId: 's1',
        items: [{ location: 'ห้องนอน', room: '', symptom: 'รั่วซึม', note: '', files: [{ path: 'tenant/form-x/1.jpg', mediaType: 'image', bytes: 10 }] }],
        preferredDays: [],
        preferredSlot: null,
        note: '',
      },
    })
    expect(localStorage.getItem('repair-form:tok')).toBe(null)
  })

  it('a submit answered already:true shows the same done screen', async () => {
    submitReply = { data: { ok: true, ticketNumber: 'RP2611-007', already: true }, error: null }
    const send = await fillOneItemAndGoToConfirm()
    fireEvent.click(send)
    expect(await screen.findByText('รับเรื่องแล้ว เลขที่ RP2611-007')).toBeTruthy()
  })

  it('a 400 with errors keeps the confirm screen and shows them', async () => {
    submitReply = { data: null, error: { message: 'FunctionsHttpError', context: { status: 400, json: async () => ({ errors: ['ไซท์ไม่ถูกต้อง'] }) } } }
    const send = await fillOneItemAndGoToConfirm()
    fireEvent.click(send)
    expect(await screen.findByText('ไซท์ไม่ถูกต้อง')).toBeTruthy()
    expect(screen.getByRole('button', { name: /ส่งแจ้งซ่อม/ })).toBeTruthy()
  })

  it('a 500 shows the generic retry message and keeps the state', async () => {
    submitReply = { data: null, error: { message: 'FunctionsHttpError', context: { status: 500, json: async () => { throw new Error('x') } } } }
    const send = await fillOneItemAndGoToConfirm()
    fireEvent.click(send)
    expect(await screen.findByText('ส่งไม่สำเร็จ กรุณาลองใหม่')).toBeTruthy()
    expect(screen.getByText('ห้องนอน')).toBeTruthy()
  })

  it('restores a saved draft and skips the site step', async () => {
    invoke.mockImplementation(async (_n, { body }) => (body.action === 'info'
      ? { data: { ...info, sites: [site, { id: 's2', name: 'อาคาร ABC' }] }, error: null }
      : submitReply))
    localStorage.setItem('repair-form:tok', JSON.stringify({
      step: 'list', siteId: 's2',
      items: [{ location: 'ครัว', room: '', symptom: 'รั่วซึม', note: '', files: [{ path: 'p/1.jpg', mediaType: 'image', bytes: 3 }] }],
      draft: { location: '', room: '', symptom: '', note: '', files: [], uploading: 0 },
      editIndex: null, preferredDays: [], preferredSlot: null, note: '', ticketNumber: null,
    }))
    render(<RepairFormPage token="tok" />)
    expect(await screen.findByText('อาคาร ABC')).toBeTruthy()
    expect(screen.getByText('ครัว')).toBeTruthy()
    expect(screen.queryByText('แจ้งซ่อมงานไหนครับ')).toBe(null)
  })
})

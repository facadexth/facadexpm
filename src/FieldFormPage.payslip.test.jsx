// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const invoke = vi.fn()
const downloadPDF = vi.fn()
vi.mock('./lib/supabase.js', () => ({
  supabase: { functions: { invoke: (...a) => invoke(...a) } },
  fmt: (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
}))
vi.mock('./lib/pdf.js', () => ({ downloadPDF: (...a) => downloadPDF(...a) }))

import FieldFormPage, { thaiOr } from './FieldFormPage.jsx'

const info = { actionType: 'payslip', workerName: 'สมชาย', months: [{ year: 2026, month: 9, netPay: 15000 }, { year: 2026, month: 8, netPay: 14000.5 }] }
const slip = {
  tenant: { company_name: 'บจก. ทดสอบ', tax_id: '0105500000000' },
  worker: { name: 'สมชาย ใจดี', nickname: 'ชาย', employee_code: 'E01', position: 'ช่าง', bank_account_name: '' },
  record: { worker_id: 'w1', net_pay: 15000, paid_date: '2026-09-30', facts: {}, salary_record_lines: [] },
  period: { status: 'closed', paid_date: '2026-09-30' },
  otItem: null,
  ytd: { earnings: 100000, sso: 750, contrib: 0 },
}

const setup = (infoData = info, slipResp = { data: slip, error: null }) =>
  invoke.mockImplementation(async (_n, { body }) => (body.action === 'info' ? { data: infoData, error: null } : slipResp))

beforeEach(() => {
  cleanup()
  invoke.mockReset()
  downloadPDF.mockReset()
  downloadPDF.mockResolvedValue()
  setup()
})

describe('FieldFormPage payslip', () => {
  it('renders the month list with labels', async () => {
    render(<FieldFormPage token="t" />)
    expect(await screen.findByText('🧾 สลิปเงินเดือน')).toBeTruthy()
    expect(screen.getByText('ก.ย. 2569 · สุทธิ 15,000.00 บาท')).toBeTruthy()
    expect(screen.getByText('ส.ค. 2569 · สุทธิ 14,000.50 บาท')).toBeTruthy()
  })

  it('renders the empty state', async () => {
    setup({ ...info, months: [] })
    render(<FieldFormPage token="t" />)
    expect(await screen.findByText('ยังไม่มีสลิปที่ปิดงวดแล้วใน 12 เดือนล่าสุด')).toBeTruthy()
  })

  it('tapping a month calls slip and shows the sheet with worker and net pay', async () => {
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByText(/ก.ย. 2569/))
    await waitFor(() => expect(document.getElementById('payslip-a5')).toBeTruthy())
    expect(invoke.mock.calls.find(c => c[1].body.action === 'slip')[1].body).toEqual({ action: 'slip', token: 't', year: 2026, month: 9 })
    const sheet = document.getElementById('payslip-a5')
    expect(sheet.textContent).toContain('สมชาย ใจดี')
    expect(sheet.textContent).toContain('15,000.00')
    expect(screen.getByText('← เลือกเดือนอื่น')).toBeTruthy()
  })

  it('saves the PDF with the right name and options, then goes back to the list', async () => {
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByText(/ก.ย. 2569/))
    fireEvent.click(await screen.findByText('⬇️ บันทึก PDF'))
    await waitFor(() => expect(downloadPDF).toHaveBeenCalled())
    expect(downloadPDF).toHaveBeenCalledWith('payslip-a5', 'สลิปเงินเดือน_ชาย_ก.ย.2569.pdf', { format: 'a5', orientation: 'landscape', margin: 0 })
    await waitFor(() => expect(screen.getByText('⬇️ บันทึก PDF').disabled).toBe(false))
    fireEvent.click(screen.getByText('← เลือกเดือนอื่น'))
    expect(await screen.findByText(/ส.ค. 2569/)).toBeTruthy()
  })

  it('shows ไม่พบสลิปเดือนนี้ for no_slip and stays on the list', async () => {
    setup(info, { data: { reason: 'no_slip' }, error: null })
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByText(/ก.ย. 2569/))
    expect(await screen.findByText('ไม่พบสลิปเดือนนี้')).toBeTruthy()
    expect(screen.getByText(/ส.ค. 2569/)).toBeTruthy()
    expect(document.getElementById('payslip-a5')).toBeNull()
  })

  it('shows the expired message from the slip call', async () => {
    setup(info, { data: { reason: 'expired' }, error: null })
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByText(/ก.ย. 2569/))
    expect(await screen.findByText(/ลิงก์นี้หมดอายุแล้ว/)).toBeTruthy()
  })

  it('shows the server message of a 400', async () => {
    setup(info, { data: null, error: { message: 'x', context: { json: async () => ({ error: 'ข้อมูลไม่ถูกต้อง' }) } } })
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByText(/ก.ย. 2569/))
    expect(await screen.findByText('ข้อมูลไม่ถูกต้อง')).toBeTruthy()
  })

  it('thaiOr keeps Thai text and replaces anything else', () => {
    expect(thaiOr('ข้อมูลไม่ถูกต้อง', 'x')).toBe('ข้อมูลไม่ถูกต้อง')
    expect(thaiOr('Failed to fetch', 'ส่งไม่สำเร็จ กรุณาลองใหม่')).toBe('ส่งไม่สำเร็จ กรุณาลองใหม่')
    expect(thaiOr(undefined, 'f')).toBe('f')
  })

  it('never shows a non-Thai request error', async () => {
    setup(info, { data: null, error: { message: 'Failed to fetch' } })
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByText(/ก.ย. 2569/))
    expect(await screen.findByText('ส่งไม่สำเร็จ กรุณาลองใหม่')).toBeTruthy()
  })

  it('never shows a non-Thai PDF error', async () => {
    downloadPDF.mockRejectedValue(new Error('canvas boom'))
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByText(/ก.ย. 2569/))
    fireEvent.click(await screen.findByText('⬇️ บันทึก PDF'))
    expect(await screen.findByText('บันทึก PDF ไม่สำเร็จ กรุณาลองใหม่')).toBeTruthy()
  })

  it('payslip_disabled from info, and old payroll_disabled from slip, read as payslip copy', async () => {
    setup({ reason: 'payslip_disabled' })
    render(<FieldFormPage token="t" />)
    expect(await screen.findByText('ยังขอสลิปผ่าน LINE ไม่ได้ ติดต่อแอดมินครับ')).toBeTruthy()
    cleanup()
    setup(info, { data: { reason: 'payroll_disabled' }, error: null })
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByText(/ก.ย. 2569/))
    expect(await screen.findByText('ยังขอสลิปผ่าน LINE ไม่ได้ ติดต่อแอดมินครับ')).toBeTruthy()
  })

  it('shows กำลังโหลดสลิป… while a month loads', async () => {
    let release
    invoke.mockImplementation((_n, { body }) => body.action === 'info'
      ? Promise.resolve({ data: info, error: null })
      : new Promise(r => { release = () => r({ data: slip, error: null }) }))
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByText(/ก.ย. 2569/))
    expect(await screen.findByText('กำลังโหลดสลิป…')).toBeTruthy()
    release()
    await waitFor(() => expect(screen.queryByText('กำลังโหลดสลิป…')).toBeNull())
  })
})

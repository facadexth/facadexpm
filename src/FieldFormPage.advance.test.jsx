// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const invoke = vi.fn()
vi.mock('./lib/supabase.js', () => ({ supabase: { functions: { invoke: (...a) => invoke(...a) } } }))

import FieldFormPage from './FieldFormPage.jsx'

const info = { actionType: 'advance', workerName: 'สมชาย', outstanding: 12000, pendingOther: 3000, installmentOptions: [1, 2, 3, 4, 5, 6] }

beforeEach(() => {
  cleanup()
  invoke.mockReset()
  invoke.mockImplementation(async (_n, { body }) => (body.action === 'info' ? { data: info, error: null } : { data: { ok: true }, error: null }))
})

describe('FieldFormPage advance', () => {
  it('renders outstanding and pendingOther', async () => {
    render(<FieldFormPage token="t" />)
    expect(await screen.findByText(/ยอดคืนคงเหลือของคุณ 12,000 บาท/)).toBeTruthy()
    expect(screen.getByText(/รออนุมัติ 3,000 บาท/)).toBeTruthy()
    expect(screen.getByText('💸 ขอเบิกเงิน')).toBeTruthy()
  })

  it('disables submit for invalid amount and shows the error', async () => {
    render(<FieldFormPage token="t" />)
    const input = (await screen.findByText('จำนวนเงิน (บาท) *')).parentElement.querySelector('input')
    const btn = screen.getByRole('button', { name: /ส่งคำขอ/ })
    expect(btn.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'abc' } })
    expect(btn.disabled).toBe(true)
    expect(screen.getByText(/จำนวนเงินต้องมากกว่า 0/)).toBeTruthy()
  })

  it('shows per-month preview and submits the right body', async () => {
    render(<FieldFormPage token="t" />)
    const input = (await screen.findByText('จำนวนเงิน (บาท) *')).parentElement.querySelector('input')
    fireEvent.change(input, { target: { value: '1,000' } })
    expect(screen.getByText('ผ่อน 3 เดือน (เดือนละ ~334 บาท)')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /ส่งคำขอ/ }))
    await waitFor(() => expect(screen.getByText(/รอเจ้าของอนุมัติ/)).toBeTruthy())
    const submitCall = invoke.mock.calls.find(c => c[1].body.action === 'submit')
    expect(submitCall[1].body).toEqual({ action: 'submit', token: 't', amount: '1,000', installments: 3, title: '' })
  })

  it('shows payroll_disabled message', async () => {
    invoke.mockImplementation(async () => ({ data: { reason: 'payroll_disabled' }, error: null }))
    render(<FieldFormPage token="t" />)
    expect(await screen.findByText(/ยังขอเบิกเงินผ่านไลน์ไม่ได้/)).toBeTruthy()
  })
})

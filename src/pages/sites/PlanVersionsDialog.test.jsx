// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const rpc = vi.fn()
vi.mock('../../lib/supabase.js', () => ({ supabase: { rpc: (...a) => rpc(...a) } }))

import PlanVersionsDialog, { planPreChecks } from './PlanVersionsDialog.jsx'

const okPhases = [
  { id: 'a', name: 'A', start_date: '2026-10-01', end_date: '2026-10-10', billing_weight_pct: 60 },
  { id: 'b', name: 'B', start_date: '2026-10-11', end_date: '2026-10-20', billing_weight_pct: 40 },
]
const plans = [
  { id: 'p2', version: 2, note: 'เลื่อนส่งมอบ', is_auto: false, created_by: 'pm@x.co', created_at: '2026-10-10T03:00:00Z' },
  { id: 'p1', version: 1, note: 'PLAN เริ่มต้น', is_auto: true, created_by: null, created_at: '2026-10-01T03:00:00Z' },
]
const mount = (over = {}) => render(
  <PlanVersionsDialog siteId="s1" phases={okPhases} plans={plans} canSave onClose={() => {}} onSaved={() => {}} {...over} />)

afterEach(() => { cleanup(); rpc.mockReset() })

describe('PlanVersionsDialog', () => {
  it('lists versions with the auto badge', () => {
    mount()
    expect(screen.getByText('เลื่อนส่งมอบ')).toBeTruthy()
    expect(screen.getByText('PLAN เริ่มต้น')).toBeTruthy()
    expect(screen.getAllByText('อัตโนมัติ')).toHaveLength(1)
  })
  it('disables save while the reason is empty', () => {
    mount()
    expect(screen.getByText('บันทึก PLAN v3', { selector: 'button' }).disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(/ลูกค้าเลื่อน/), { target: { value: '   ' } })
    expect(screen.getByText('บันทึก PLAN v3', { selector: 'button' }).disabled).toBe(true)
  })
  it('disables save when dates are missing or weights are not 100', () => {
    mount({ phases: [{ ...okPhases[0], end_date: null }, okPhases[1]] })
    fireEvent.change(screen.getByPlaceholderText(/ลูกค้าเลื่อน/), { target: { value: 'x' } })
    expect(screen.getByText('บันทึก PLAN v3', { selector: 'button' }).disabled).toBe(true)
    cleanup()
    mount({ phases: [okPhases[0]] })
    fireEvent.change(screen.getByPlaceholderText(/ลูกค้าเลื่อน/), { target: { value: 'x' } })
    expect(screen.getByText('บันทึก PLAN v3', { selector: 'button' }).disabled).toBe(true)
  })
  it('calls the RPC with the trimmed note and closes', async () => {
    rpc.mockResolvedValue({ data: 3, error: null })
    const onClose = vi.fn(); const onSaved = vi.fn()
    mount({ onClose, onSaved })
    fireEvent.change(screen.getByPlaceholderText(/ลูกค้าเลื่อน/), { target: { value: '  เปลี่ยนแผน  ' } })
    fireEvent.click(screen.getByText('บันทึก PLAN v3', { selector: 'button' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(rpc).toHaveBeenCalledWith('save_site_plan', { p_site_id: 's1', p_note: 'เปลี่ยนแผน' })
    expect(onClose).toHaveBeenCalled()
  })
  it('shows the DB error message verbatim and stays open', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'น้ำหนักเฟสรวม 90% ต้องเท่ากับ 100%' } })
    const onClose = vi.fn()
    mount({ onClose })
    fireEvent.change(screen.getByPlaceholderText(/ลูกค้าเลื่อน/), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('บันทึก PLAN v3', { selector: 'button' }))
    expect((await screen.findByRole('alert')).textContent).toBe('น้ำหนักเฟสรวม 90% ต้องเท่ากับ 100%')
    expect(onClose).not.toHaveBeenCalled()
  })
  it('ignores VO and issue phases in the pre-checks', () => {
    const c = planPreChecks([...okPhases, { id: 'v', name: 'VO', is_vo: true, billing_weight_pct: 0 }, { id: 'i', name: 'I', is_issue_phase: true }])
    expect(c.missingDates).toHaveLength(0)
    expect(c.weightOk).toBe(true)
  })
})

import { PlanBar } from './PlanVersionsDialog.jsx'

describe('PlanBar', () => {
  const bar = (over) => render(<PlanBar plans={[]} loading={false} loadError={null} canManage onOpen={() => {}} {...over} />)
  it('shows the banner and v1 button when there is no PLAN', () => {
    bar()
    expect(screen.getByText(/ยังไม่มี PLAN ต้องบันทึก PLAN v1/)).toBeTruthy()
    expect(screen.getByText('บันทึก PLAN v1', { selector: 'button' })).toBeTruthy()
  })
  it('hides the v1 button for ADMIN (canManage false)', () => {
    bar({ canManage: false })
    expect(screen.getByText(/ยังไม่มี PLAN/)).toBeTruthy()
    expect(screen.queryByText('บันทึก PLAN v1', { selector: 'button' })).toBeNull()
  })
  it('hides the banner when plans exist and offers the new-PLAN button', () => {
    bar({ plans })
    expect(screen.queryByText(/ยังไม่มี PLAN/)).toBeNull()
    expect(screen.getByText('บันทึกเป็น PLAN ใหม่')).toBeTruthy()
  })
  it('hides the new-PLAN button for ADMIN', () => {
    bar({ plans, canManage: false })
    expect(screen.queryByText('บันทึกเป็น PLAN ใหม่')).toBeNull()
  })
  it('shows nothing when the fetch errored or is loading', () => {
    const { container } = bar({ loadError: 'relation does not exist' })
    expect(container.innerHTML).toBe('')
    cleanup()
    expect(bar({ loading: true }).container.innerHTML).toBe('')
  })
})

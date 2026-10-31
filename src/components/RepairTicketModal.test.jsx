// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const state = vi.hoisted(() => ({ ticket: null, rpc: null }))

vi.mock('../lib/supabase.js', () => {
  const chain = (result) => {
    const c = {}
    for (const m of ['select', 'eq', 'order', 'update', 'neq', 'in']) c[m] = () => c
    c.maybeSingle = () => Promise.resolve(result())
    c.then = (res, rej) => Promise.resolve(result()).then(res, rej)
    return c
  }
  return {
    supabase: {
      from: (table) => chain(() => (table === 'repair_tickets'
        ? { data: state.ticket, error: null }
        : { data: [], error: null })),
      rpc: (...args) => state.rpc(...args),
      storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [], error: null }) }) },
    },
  }
})
vi.mock('../hooks/useUserRole.js', () => ({ useUserRole: () => ({ role: 'OWNER', isAtLeast: () => true }) }))
vi.mock('../hooks/useTenant.js', () => ({ useTenant: () => ({ hasModuleAccess: () => true, loading: false }) }))
vi.mock('../hooks/useSupabase.js', () => ({
  useWorkers: () => ({ data: [{ id: 'w1', name: 'สมชาย', nickname: 'ต้น' }, { id: 'w2', name: 'สมศักดิ์', nickname: 'บอย' }] }),
}))
vi.mock('../lib/permissions.js', () => ({ canEditPage: () => true }))
vi.mock('../lib/repairPush.js', () => ({ invokeRepairPush: vi.fn(), customerPushDefault: () => false }))

import RepairTicketModal, { ConflictBox } from './RepairTicketModal.jsx'

const baseTicket = {
  id: 't1', tenant_id: 'tn', site_id: 's1', ticket_number: 'RP2610-001', status: 'received', source: 'staff',
  created_at: '2026-10-20T03:00:00Z', sites: { name: 'บ้าน A', status: 'done' }, description: 'x',
}

afterEach(cleanup)
beforeEach(() => { state.ticket = { ...baseTicket }; state.rpc = vi.fn() })

describe('ConflictBox', () => {
  const nameOf = (id) => ({ w1: 'ต้น', w2: 'บอย' }[id])
  it('renders one line per conflict with the other job label', () => {
    render(<ConflictBox conflicts={{ date: '2099-11-10', list: [
      { worker_id: 'w1', shift: 'morning', label: 'FX-2026-013 SOAP OPERA', checked_in: false },
      { worker_id: 'w2', shift: 'evening', type: 'leave', label: 'leave', checked_in: false },
    ] }} workerIds={['w1', 'w2']} nameOf={nameOf} onOverwrite={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('alert').textContent).toContain('ช่างมีงานอื่นในวันที่')
    expect(screen.getByText('• ต้น — กะเช้า: FX-2026-013 SOAP OPERA')).toBeTruthy()
    expect(screen.getByText('• บอย — กะบ่าย: ลา')).toBeTruthy()
    expect(screen.getByText('เขียนทับ แล้วบันทึกนัด').disabled).toBe(false)
  })
  it('checked-in conflict is listed separately and disables เขียนทับ until unticked', () => {
    const list = [{ worker_id: 'w1', shift: 'morning', label: 'FX-1 A', checked_in: true }]
    const { rerender } = render(<ConflictBox conflicts={{ date: '2099-11-10', list }} workerIds={['w1']} nameOf={nameOf} onOverwrite={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('เช็คอินแล้ว — ย้ายไม่ได้')).toBeTruthy()
    expect(screen.getByText('เขียนทับ แล้วบันทึกนัด').disabled).toBe(true)
    rerender(<ConflictBox conflicts={{ date: '2099-11-10', list }} workerIds={[]} nameOf={nameOf} onOverwrite={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('เขียนทับ แล้วบันทึกนัด').disabled).toBe(false)
    expect(screen.queryByText('เช็คอินแล้ว — ย้ายไม่ได้')).toBeNull()
    expect(screen.queryByText('• ต้น — กะเช้า: FX-1 A')).toBeNull()
  })
  it('leave types use the Thai labels, factory/subcontract mapped, unknown types show งานอื่น', () => {
    render(<ConflictBox conflicts={{ date: '2099-11-10', list: [
      { worker_id: 'w1', shift: 'morning', type: 'leave_sick', label: 'leave_sick', checked_in: false },
      { worker_id: 'w2', shift: 'morning', type: 'weird', label: 'weird', checked_in: false },
      { worker_id: 'w1', shift: 'evening', type: 'factory', label: 'FX-9 โรงงานหลัก', checked_in: false },
      { worker_id: 'w2', shift: 'evening', type: 'subcontract', label: 'subcontract', checked_in: false },
    ] }} workerIds={['w1', 'w2']} nameOf={nameOf} onOverwrite={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('• ต้น — กะเช้า: ลาป่วย')).toBeTruthy()
    expect(screen.getByText('• บอย — กะเช้า: งานอื่น')).toBeTruthy()
    expect(screen.getByText('• ต้น — กะบ่าย: โรงงาน · FX-9 โรงงานหลัก')).toBeTruthy()
    expect(screen.getByText('• บอย — กะบ่าย: ผู้รับเหมา')).toBeTruthy()
  })
  it('ยกเลิก calls onCancel', () => {
    const onCancel = vi.fn()
    render(<ConflictBox conflicts={{ date: '2099-11-10', list: [] }} workerIds={[]} nameOf={nameOf} onOverwrite={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('ยกเลิก (เลือกช่างใหม่)'))
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('RepairTicketModal', () => {
  it('conflict -> เขียนทับ calls the RPC again with p_overwrite true', async () => {
    state.rpc
      .mockResolvedValueOnce({ data: { ok: false, conflicts: [{ worker_id: 'w1', shift: 'morning', label: 'FX-2026-013 SOAP OPERA', checked_in: false }] }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, overwritten: 1, inserted: 1, status: 'scheduled' }, error: null })
    render(<RepairTicketModal ticketId="t1" onClose={() => {}} onChanged={() => {}} />)
    await screen.findByText('บันทึกนัด')
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2099-11-10' } })
    fireEvent.click(screen.getByText('สมชาย (ต้น)'))
    fireEvent.click(screen.getByText('บันทึกนัด'))
    await screen.findByText('• สมชาย (ต้น) — กะเช้า: FX-2026-013 SOAP OPERA')
    expect(state.rpc.mock.calls[0][1].p_overwrite).toBe(false)
    fireEvent.click(screen.getByText('เขียนทับ แล้วบันทึกนัด'))
    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(2))
    expect(state.rpc.mock.calls[1][0]).toBe('schedule_repair_ticket')
    expect(state.rpc.mock.calls[1][1].p_overwrite).toBe(true)
    await screen.findByText(/ถอนจากงานเดิม 1 กะ/)
  })
  it('ปิดงาน is enabled on scheduled (นัดแล้ว)', async () => {
    state.ticket = { ...baseTicket, status: 'scheduled', scheduled_date: '2099-11-10', scheduled_start: '09:00', duration_hours: 2 }
    render(<RepairTicketModal ticketId="t1" onClose={() => {}} onChanged={() => {}} />)
    const btn = await screen.findByText('ปิดงาน (เสร็จ)')
    expect(btn.disabled).toBe(false)
    expect(screen.queryByText(/เริ่มซ่อม" ด้านบนก่อน/)).toBeNull()
  })
  it('ปิดงาน stays disabled on received with the new hint', async () => {
    render(<RepairTicketModal ticketId="t1" onClose={() => {}} onChanged={() => {}} />)
    const btn = await screen.findByText('ปิดงาน (เสร็จ)')
    expect(btn.disabled).toBe(true)
    expect(screen.getByText('นัดวันก่อน แล้วปิดงานได้')).toBeTruthy()
  })
})

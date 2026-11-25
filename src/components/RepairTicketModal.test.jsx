// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const state = vi.hoisted(() => ({ ticket: null, rpc: null, items: [], media: [], itemUpdate: null, updates: [], signed: [], leaders: [] }))

vi.mock('../lib/supabase.js', () => {
  const chain = (table) => {
    const call = { table, op: 'select', patch: null, eqs: [] }
    const result = () => {
      if (table === 'repair_tickets') return { data: state.ticket, error: null }
      if (table === 'repair_ticket_items') {
        if (call.op === 'update') return state.itemUpdate || { data: [{ id: call.eqs.find(([k]) => k === 'id')?.[1] }], error: null }
        return { data: state.items, error: null }
      }
      if (table === 'repair_ticket_media') return { data: state.media, error: null }
      if (table === 'worker_assignments' && call.eqs.some(([k]) => k === 'is_team_leader')) return { data: state.leaders, error: null }
      return { data: [], error: null }
    }
    const c = {}
    for (const m of ['select', 'order', 'neq', 'in', 'limit']) c[m] = () => c
    c.eq = (k, v) => { call.eqs.push([k, v]); return c }
    c.update = (patch) => { call.op = 'update'; call.patch = patch; state.updates.push(call); return c }
    c.maybeSingle = () => Promise.resolve(result())
    c.then = (res, rej) => Promise.resolve(result()).then(res, rej)
    return c
  }
  return {
    supabase: {
      from: (table) => chain(table),
      rpc: (...args) => state.rpc(...args),
      storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: state.signed, error: null }) }) },
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
beforeEach(() => {
  state.ticket = { ...baseTicket }; state.rpc = vi.fn()
  state.items = []; state.media = []; state.itemUpdate = null; state.updates = []; state.signed = []
})

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

describe('RepairTicketModal — customer repair form items', () => {
  const items = [
    { id: 'i1', seq: 1, location: 'ห้องนอน', room: 'ห้องนอนใหญ่', symptom: 'รั่วซึม', note: 'น้ำซึมตอนฝนตก', result: null, result_note: null },
    { id: 'i2', seq: 2, location: 'ครัว', room: null, symptom: 'เปิดปิดยาก', note: null, result: null, result_note: null },
  ]
  const open = () => render(<RepairTicketModal ticketId="t1" onClose={() => {}} onChanged={() => {}} />)
  const itemSelects = () => Array.from(document.querySelectorAll('select[data-item-result]'))

  it('a ticket with 2 items shows the item table', async () => {
    state.items = items
    open()
    await screen.findByText('รายการแจ้งซ่อม')
    expect(screen.getByText('ห้องนอน (ห้องนอนใหญ่)')).toBeTruthy()
    expect(screen.getByText('รั่วซึม')).toBeTruthy()
    expect(screen.getByText('น้ำซึมตอนฝนตก')).toBeTruthy()
    expect(screen.getByText('ครัว')).toBeTruthy()
    expect(itemSelects()).toHaveLength(2)
  })

  it('pending_review: the result select is disabled', async () => {
    state.ticket = { ...baseTicket, status: 'pending_review' }
    state.items = items
    open()
    await screen.findByText('รายการแจ้งซ่อม')
    const sel = itemSelects()
    expect(sel.length === 0 || sel.every((x) => x.disabled)).toBe(true)
  })

  it('in_progress: choosing ซ่อมแล้ว updates that item with { result: fixed }', async () => {
    state.ticket = { ...baseTicket, status: 'in_progress', scheduled_date: '2099-11-10', scheduled_start: '09:00' }
    state.items = items
    open()
    await screen.findByText('รายการแจ้งซ่อม')
    const sel = itemSelects()[0]
    expect(sel.disabled).toBe(false)
    fireEvent.change(sel, { target: { value: 'fixed' } })
    await waitFor(() => expect(state.updates.filter((u) => u.table === 'repair_ticket_items')).toHaveLength(1))
    const u = state.updates.find((x) => x.table === 'repair_ticket_items')
    expect(u.patch).toEqual({ result: 'fixed' })
    expect(u.eqs).toContainEqual(['id', 'i1'])
    expect(u.eqs).toContainEqual(['tenant_id', 'tn'])
    await waitFor(() => expect(itemSelects()[0].value).toBe('fixed'))
  })

  it('in_progress: an empty choice saves null', async () => {
    state.ticket = { ...baseTicket, status: 'in_progress', scheduled_date: '2099-11-10', scheduled_start: '09:00' }
    state.items = [{ ...items[0], result: 'partial' }]
    open()
    await screen.findByText('รายการแจ้งซ่อม')
    fireEvent.change(itemSelects()[0], { target: { value: '' } })
    await waitFor(() => expect(state.updates.filter((u) => u.table === 'repair_ticket_items')).toHaveLength(1))
    expect(state.updates.find((x) => x.table === 'repair_ticket_items').patch).toEqual({ result: null })
  })

  it('update returning [] shows an error and keeps the old value', async () => {
    state.ticket = { ...baseTicket, status: 'done', scheduled_date: '2099-11-10', scheduled_start: '09:00' }
    state.items = items
    state.itemUpdate = { data: [], error: null }
    open()
    await screen.findByText('รายการแจ้งซ่อม')
    fireEvent.change(itemSelects()[0], { target: { value: 'fixed' } })
    await screen.findByText(/บันทึกผลไม่สำเร็จ/)
    expect(itemSelects()[0].value).toBe('')
  })

  it('item photos show as thumbnails in that row and open the lightbox', async () => {
    state.items = items
    state.media = [
      { id: 'm1', ticket_id: 't1', role: 'customer', media_type: 'image', storage_path: 'tn/t1/a.jpg', item_id: 'i1' },
      { id: 'm2', ticket_id: 't1', role: 'customer', media_type: 'image', storage_path: 'tn/t1/b.jpg', item_id: null },
    ]
    state.signed = [{ path: 'tn/t1/a.jpg', signedUrl: 'https://x/a.jpg' }, { path: 'tn/t1/b.jpg', signedUrl: 'https://x/b.jpg' }]
    open()
    await screen.findByText('รายการแจ้งซ่อม')
    await waitFor(() => expect(document.querySelector('tr[data-item="i1"] img')).toBeTruthy())
    const row1 = document.querySelector('tr[data-item="i1"]')
    expect(row1.querySelectorAll('img')).toHaveLength(1)
    expect(row1.querySelector('img').getAttribute('src')).toBe('https://x/a.jpg')
    expect(document.querySelector('tr[data-item="i2"] img')).toBeNull()
    fireEvent.click(row1.querySelector('img').closest('button'))
    expect(screen.getByRole('dialog', { name: 'ดูรูป' })).toBeTruthy()
  })

  // Only Date is faked (timers stay real, so findBy/waitFor still poll). 05:00Z = 12:00 Bangkok.
  const atBangkok = (day) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${day}T05:00:00Z`)) }
  afterEach(() => vi.useRealTimers())

  it('preferred days prefill the date + 22:00 for กลางคืน and show ลูกค้าสะดวก', async () => {
    atBangkok('2026-11-25')
    state.ticket = { ...baseTicket, preferred_days: ['2026-12-02', '2026-12-04'], preferred_slot: 'night' }
    open()
    await screen.findByText('บันทึกนัด')
    await waitFor(() => expect(document.querySelector('input[type="date"]').value).toBe('2026-12-02'))
    expect(document.querySelector('input[type="time"]').value).toBe('22:00')
    const pref = screen.getByText(/ลูกค้าสะดวก:/)
    expect(pref.textContent).toContain('02/12/2569')
    expect(pref.textContent).toContain('04/12/2569')
    expect(pref.textContent).toContain('กลางคืน')
  })

  it('today 2026-12-03: a past preferred day is skipped, the date is the first day from today on', async () => {
    atBangkok('2026-12-03')
    state.ticket = { ...baseTicket, preferred_days: ['2026-12-02', '2026-12-04'], preferred_slot: 'night' }
    open()
    await screen.findByText('บันทึกนัด')
    await waitFor(() => expect(document.querySelector('input[type="date"]').value).toBe('2026-12-04'))
    expect(document.querySelector('input[type="time"]').value).toBe('22:00')
    expect(screen.getByText(/ลูกค้าสะดวก:/).textContent).toContain('02/12/2569, 04/12/2569')
  })

  it('today 2026-12-05: every preferred day is past, so no date prefill (start still 22:00)', async () => {
    atBangkok('2026-12-05')
    state.ticket = { ...baseTicket, preferred_days: ['2026-12-02', '2026-12-04'], preferred_slot: 'night' }
    open()
    await screen.findByText('บันทึกนัด')
    await waitFor(() => expect(document.querySelector('input[type="time"]').value).toBe('22:00'))
    expect(document.querySelector('input[type="date"]').value).toBe('')
    expect(screen.getByText(/ลูกค้าสะดวก:/).textContent).toContain('02/12/2569, 04/12/2569')
  })

  it('today 2026-12-02: a preferred day equal to today is used', async () => {
    atBangkok('2026-12-02')
    state.ticket = { ...baseTicket, preferred_days: ['2026-12-02', '2026-12-04'], preferred_slot: 'day' }
    open()
    await screen.findByText('บันทึกนัด')
    await waitFor(() => expect(document.querySelector('input[type="date"]').value).toBe('2026-12-02'))
    expect(document.querySelector('input[type="time"]').value).toBe('09:00')
  })

  it('a saved schedule wins over the preferred days', async () => {
    state.ticket = { ...baseTicket, status: 'scheduled', scheduled_date: '2099-11-10', scheduled_start: '10:30', duration_hours: 2, preferred_days: ['2026-12-02'], preferred_slot: 'night' }
    open()
    await screen.findByText('บันทึกนัด')
    await waitFor(() => expect(document.querySelector('input[type="date"]').value).toBe('2099-11-10'))
    expect(document.querySelector('input[type="time"]').value).toBe('10:30')
  })

  it('a ticket without items shows no รายการแจ้งซ่อม heading', async () => {
    open()
    await screen.findByText('บันทึกนัด')
    expect(screen.queryByText('รายการแจ้งซ่อม')).toBeNull()
    expect(screen.queryByText(/ลูกค้าสะดวก/)).toBeNull()
  })
})

describe('RepairTicketModal — suggested team leader', () => {
  beforeEach(() => { state.items = []; state.media = []; state.updates = []; state.leaders = [] })
  afterEach(() => { state.leaders = [] })
  const open = () => render(<RepairTicketModal ticketId="t1" onClose={() => {}} onChanged={() => {}} />)

  it('shows ★ หัวหน้างานที่แนะนำ for the most frequent leader at the site; เลือก ticks only that worker', async () => {
    state.ticket = { ...baseTicket }
    state.leaders = [
      { worker_id: 'w2', date: '2026-10-01' }, { worker_id: 'w2', date: '2026-10-02' }, { worker_id: 'w1', date: '2026-10-03' },
    ]
    open()
    const box = await screen.findByText(/หัวหน้างานที่แนะนำ/)
    expect(box.parentElement.textContent).toContain('สมศักดิ์ (บอย)')
    expect(screen.getByText('คุมงานไซท์นี้ 2 วัน')).toBeTruthy()
    // not ticked until staff choose
    expect(screen.getByText('ยังไม่เลือก')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'เลือก' }))
    expect(screen.getByText('1 คน')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'เลือก' })).toBeNull()
  })

  it('no leader history at the site -> no suggestion', async () => {
    state.ticket = { ...baseTicket }
    open()
    await screen.findByText('บันทึกนัด')
    expect(screen.queryByText(/หัวหน้างานที่แนะนำ/)).toBeNull()
  })
})

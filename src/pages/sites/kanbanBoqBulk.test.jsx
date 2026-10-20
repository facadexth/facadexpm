// @vitest-environment jsdom
// Kanban in BOQ mode: per-phase remaining qty in the card form, the "+ การ์ดจาก BOQ (n)"
// button per phase and the one-click bulk card dialog.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const calls = []
let splitRows = []
let insertResult = { data: [], error: null }
const chain = (table) => {
  const q = { _insert: false }
  ;['select', 'eq', 'order', 'in', 'is', 'not', 'limit', 'upsert', 'update', 'delete'].forEach((m) => {
    q[m] = (...a) => { calls.push([table, m, ...a]); return q }
  })
  q.insert = (...a) => { calls.push([table, 'insert', ...a]); q._insert = true; return q }
  q.range = async (from, to) => { calls.push([table, 'range', from, to]); return table === 'boq_phase_splits' ? { data: splitRows.slice(from, to + 1), error: null } : { data: [], error: null } }
  q.then = (resolve, reject) => {
    const res = table === 'boq_phase_splits' ? { data: splitRows, error: null }
      : table === 'phase_tasks' && q._insert ? insertResult
        : { data: [], error: null }
    return Promise.resolve(res).then(resolve, reject)
  }
  return q
}
vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (t) => chain(t),
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [] }) }) },
  },
}))
let mockRole = 'PM'
vi.mock('../../hooks/useUserRole.js', () => ({ useUserRole: () => ({ role: mockRole }) }))
vi.mock('../../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: { id: 'tn1' } }) }))
vi.mock('../../lib/progressSchema.js', () => ({ useProgressSchemaReady: () => true }))
const auditLog = vi.fn()
vi.mock('../../lib/audit.js', () => ({ auditLog: (...a) => auditLog(...a) }))

const q = (data) => ({ data, loading: false, error: null, refetch: async () => {} })
const phases = [
  { id: 'make', site_id: 's1', name: 'ผลิต', sort_order: 1 },
  { id: 'install', site_id: 's1', name: 'ติดตั้ง', sort_order: 2 },
]
const boq = [
  { id: 'b1', code: '1', description: 'กระจก', unit: 'ตร.ม.', planned_qty: 26, sort_order: 1 },
  { id: 'b2', code: '2', description: 'ประตู', unit: 'ชุด', planned_qty: 1, sort_order: 2 },
  { id: 'b3', code: '3', description: 'รื้อถอน', unit: null, planned_qty: 1, sort_order: 3 },
]
const tasks = [
  { id: 't1', site_id: 's1', phase_id: 'install', subtask_id: null, name: 'หุ้มกระจก', status: 'not_started', progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: 26, done_qty: 0, weight_pts: 50, sort_order: 1, phase_task_workers: [] },
  { id: 't2', site_id: 's1', phase_id: 'make', subtask_id: null, name: 'ผลิตกระจก', status: 'not_started', progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: 20, done_qty: 0, weight_pts: 100, sort_order: 1, phase_task_workers: [] },
]
vi.mock('../../hooks/useSupabase.js', () => ({
  useSitePhases: () => q(phases),
  usePhaseTasks: () => q(tasks),
  useWorkers: () => q([]),
  useSubtasks: () => q([]),
  useSites: () => q([]),
  useBoqItems: () => q(boq),
  useSiteHasPlan: () => ({ hasPlan: true }),
  attachPmWorkerNames: async (rows) => rows || [],
}))

import PhaseKanbanBoard from './PhaseKanbanBoard.jsx'

const site = { id: 's1', name: 'ไซต์' }
const BOQ_MODE_ROWS = [
  { boq_item_id: 'b1', phase_id: 'make', pct: 40 }, { boq_item_id: 'b1', phase_id: 'install', pct: 60 },
  { boq_item_id: 'b2', phase_id: 'make', pct: 0 }, { boq_item_id: 'b2', phase_id: 'install', pct: 100 },
  { boq_item_id: 'b3', phase_id: 'make', pct: 0 }, { boq_item_id: 'b3', phase_id: 'install', pct: 100 },
]
afterEach(() => { cleanup(); calls.length = 0; auditLog.mockReset(); splitRows = []; insertResult = { data: [], error: null }; mockRole = 'PM' })

const openPhase = async (name) => {
  render(<PhaseKanbanBoard site={site} canEdit onTasksChanged={() => {}} />)
  fireEvent.click(screen.getAllByText(name)[0]) // the phase chip (the "ทั้งหมด" boards repeat the name as a heading)
  await waitFor(() => expect(screen.getAllByText('+ เพิ่มงาน').length).toBe(3))
}

describe('Kanban BOQ per phase', () => {
  it('the card form counts the remaining qty per phase: ติดตั้ง full (0), ผลิต has 6 left', async () => {
    await openPhase('ผลิต')
    fireEvent.click(screen.getAllByText('+ เพิ่มงาน')[0])
    const opt = await screen.findByText(/1 กระจก — เหลือในเฟสนี้/)
    expect(opt.textContent).toBe('1 กระจก — เหลือในเฟสนี้ 6 ตร.ม.')
    expect(screen.getByText(/2 ประตู — เหลือในเฟสนี้ 1 ชุด/)).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b1' } })
    expect(screen.getByText(/เหลือในเฟสนี้ 6 ใส่ได้ไม่เกินนี้/)).toBeTruthy()
  })
  it('no bulk button outside BOQ mode', async () => {
    await openPhase('ติดตั้ง')
    expect(screen.queryByTestId('boq-bulk-button')).toBeNull()
  })
  it('BOQ mode: "+ การ์ดจาก BOQ (n)" counts the items with pct > 0 that still have qty in this phase', async () => {
    splitRows = BOQ_MODE_ROWS
    await openPhase('ติดตั้ง')
    // install: b1 full (26/26), b2 open, b3 open -> 2
    const btn = await screen.findByTestId('boq-bulk-button')
    expect(btn.textContent).toBe('+ การ์ดจาก BOQ (2 รายการรอสร้าง)')
  })
  it('BOQ mode: a phase where every pct>0 item is covered shows no button; pct 0 items are not counted', async () => {
    splitRows = BOQ_MODE_ROWS.map((r) => (r.boq_item_id === 'b1' && r.phase_id === 'make' ? { ...r, pct: 100 } : r))
    // make: b1 pct 100 with 6 left -> button with 1; then with t2 at full qty there would be none
    await openPhase('ผลิต')
    const btn = await screen.findByTestId('boq-bulk-button')
    expect(btn.textContent).toBe('+ การ์ดจาก BOQ (1 รายการรอสร้าง)')
  })
  it('an ADMIN never sees the bulk button', async () => {
    mockRole = 'ADMIN'
    splitRows = BOQ_MODE_ROWS
    await openPhase('ติดตั้ง')
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByTestId('boq-bulk-button')).toBeNull()
  })
  it('the dialog lists the items pre-ticked at the remaining qty, greys out full ones, and one click inserts BOQ cards + audits', async () => {
    splitRows = BOQ_MODE_ROWS
    insertResult = { data: [{ id: 'n1', boq_item_id: 'b2', planned_qty: 1 }, { id: 'n2', boq_item_id: 'b3', planned_qty: 1 }], error: null }
    await openPhase('ติดตั้ง')
    fireEvent.click(await screen.findByTestId('boq-bulk-button'))
    expect(screen.getByText('สร้างการ์ด BOQ ในเฟส ติดตั้ง')).toBeTruthy()
    const full = screen.getByTestId('bulk-row-b1')
    expect(full.getAttribute('data-full')).toBe('true')
    expect(full.querySelector('input[type="checkbox"]').disabled).toBe(true)
    expect(full.textContent).toMatch(/มีการ์ดครบแล้ว/)
    expect(screen.getByTestId('bulk-row-b2').querySelector('input[type="checkbox"]').checked).toBe(true)
    expect(screen.getByLabelText('จำนวน ประตู').value).toBe('1')
    expect(screen.getByText('สร้าง 2 การ์ด')).toBeTruthy()
    fireEvent.click(screen.getByText('สร้าง 2 การ์ด'))
    await waitFor(() => expect(auditLog).toHaveBeenCalledTimes(2))
    const ins = calls.find((c) => c[0] === 'phase_tasks' && c[1] === 'insert')
    expect(ins[2]).toEqual([
      { site_id: 's1', phase_id: 'install', subtask_id: null, name: 'ประตู', zone: null, due_date: null, sort_order: 2, status: 'not_started', progress_mode: 'quantity', boq_item_id: 'b2', planned_qty: 1 },
      { site_id: 's1', phase_id: 'install', subtask_id: null, name: 'รื้อถอน', zone: null, due_date: null, sort_order: 3, status: 'not_started', progress_mode: 'quantity', boq_item_id: 'b3', planned_qty: 1 },
    ])
    expect(auditLog).toHaveBeenCalledWith('phase_tasks', 'n1', 'insert', null, { progress_mode: 'quantity', boq_item_id: 'b2', planned_qty: 1, phase_id: 'install' })
    await waitFor(() => expect(screen.queryByText('สร้างการ์ด BOQ ในเฟส ติดตั้ง')).toBeNull())
  })
  it('un-ticking a row drops it from the count; a DB error is shown in the dialog', async () => {
    splitRows = BOQ_MODE_ROWS
    insertResult = { data: null, error: { message: 'จำนวนในการ์ดรวมเกิน BOQ ในเฟสนี้' } }
    await openPhase('ติดตั้ง')
    fireEvent.click(await screen.findByTestId('boq-bulk-button'))
    fireEvent.click(screen.getByLabelText('ประตู'))
    expect(screen.getByText('สร้าง 1 การ์ด')).toBeTruthy()
    fireEvent.click(screen.getByText('สร้าง 1 การ์ด'))
    await waitFor(() => expect(screen.getByText('จำนวนในการ์ดรวมเกิน BOQ ในเฟสนี้')).toBeTruthy())
    expect(auditLog).not.toHaveBeenCalled()
  })
})

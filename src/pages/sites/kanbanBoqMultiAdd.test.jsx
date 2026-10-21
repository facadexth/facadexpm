// @vitest-environment jsdom
// Kanban "+ เพิ่มงาน" form, card kind BOQ: several BOQ items can be ticked at once, each
// with its own qty (default = what is left in this phase); saving inserts one card per item.
// Not BOQ mode (no splits): this works on every site. Editing a card stays single-item.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const calls = []
let insertResult = { data: [], error: null }
const chain = (table) => {
  const q = { _insert: false }
  ;['select', 'eq', 'neq', 'order', 'in', 'is', 'not', 'limit', 'upsert', 'update', 'delete', 'single'].forEach((m) => {
    q[m] = (...a) => { calls.push([table, m, ...a]); return q }
  })
  q.insert = (...a) => { calls.push([table, 'insert', ...a]); q._insert = true; return q }
  q.range = async () => ({ data: [], error: null })
  q.then = (resolve, reject) => Promise.resolve(table === 'phase_tasks' && q._insert ? insertResult : { data: [], error: null }).then(resolve, reject)
  return q
}
vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (t) => chain(t),
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [] }) }) },
  },
}))
vi.mock('../../hooks/useUserRole.js', () => ({ useUserRole: () => ({ role: 'PM' }) }))
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
  useWorkers: () => q([{ id: 'w1', name: 'สมชาย' }]),
  useSubtasks: () => q([]),
  useSites: () => q([]),
  useBoqItems: () => q(boq),
  useSiteHasPlan: () => ({ hasPlan: true }),
  attachPmWorkerNames: async (rows) => rows || [],
}))

import PhaseKanbanBoard from './PhaseKanbanBoard.jsx'

const site = { id: 's1', name: 'ไซต์' }
afterEach(() => { cleanup(); calls.length = 0; auditLog.mockReset(); insertResult = { data: [], error: null }; vi.restoreAllMocks() })

const openAddForm = async (phaseName) => {
  render(<PhaseKanbanBoard site={site} canEdit onTasksChanged={() => {}} />)
  fireEvent.click(screen.getAllByText(phaseName)[0])
  await waitFor(() => expect(screen.getAllByText('+ เพิ่มงาน').length).toBe(3))
  fireEvent.click(screen.getAllByText('+ เพิ่มงาน')[0])
  await screen.findByLabelText('เลือก กระจก')
}
const insertOf = () => calls.find((c) => c[0] === 'phase_tasks' && c[1] === 'insert')?.[2]

describe('Kanban add form: several BOQ items at once', () => {
  it('ticking 2 items (qty defaults to the remaining in this phase) saves 2 BOQ cards in one insert + audits each', async () => {
    insertResult = { data: [{ id: 'n1', boq_item_id: 'b1', planned_qty: 6 }, { id: 'n2', boq_item_id: 'b2', planned_qty: 1 }], error: null }
    await openAddForm('ผลิต')
    expect(screen.getByText(/1 กระจก — เหลือในเฟสนี้ 6 ตร\.ม\./)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('เลือก กระจก'))
    fireEvent.click(screen.getByLabelText('เลือก ประตู'))
    expect(screen.getByLabelText('จำนวน กระจก').value).toBe('6')
    expect(screen.getByLabelText('จำนวน ประตู').value).toBe('1')
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(insertOf()).toBeTruthy())
    expect(insertOf()).toEqual([
      { site_id: 's1', phase_id: 'make', subtask_id: null, name: 'กระจก', zone: null, due_date: null, sort_order: 2, status: 'not_started', progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: 6 },
      { site_id: 's1', phase_id: 'make', subtask_id: null, name: 'ประตู', zone: null, due_date: null, sort_order: 3, status: 'not_started', progress_mode: 'quantity', boq_item_id: 'b2', planned_qty: 1 },
    ])
    await waitFor(() => expect(auditLog).toHaveBeenCalledTimes(2))
    expect(auditLog).toHaveBeenCalledWith('phase_tasks', 'n1', 'insert', null, { progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: 6, phase_id: 'make' })
  })
  it('one item with a typed name keeps that name; assignees go on the new card', async () => {
    insertResult = { data: [{ id: 'n1', boq_item_id: 'b2', planned_qty: 1 }], error: null }
    await openAddForm('ผลิต')
    fireEvent.change(screen.getByPlaceholderText(/ชื่องาน/), { target: { value: 'ประตูชั้น 3' } })
    fireEvent.click(screen.getByLabelText('เลือก ประตู'))
    fireEvent.click(screen.getByText('สมชาย'))
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(insertOf()).toBeTruthy())
    expect(insertOf()).toHaveLength(1)
    expect(insertOf()[0]).toMatchObject({ name: 'ประตูชั้น 3', boq_item_id: 'b2', planned_qty: 1, progress_mode: 'quantity', status: 'not_started' })
    await waitFor(() => expect(calls.some((c) => c[0] === 'phase_task_workers' && c[1] === 'upsert')).toBe(true))
    expect(calls.find((c) => c[0] === 'phase_task_workers' && c[1] === 'upsert')[2]).toEqual([{ task_id: 'n1', worker_id: 'w1', is_lead: false }])
  })
  it('a qty over the remaining in this phase is rejected with the item named, nothing inserted', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    await openAddForm('ผลิต')
    fireEvent.click(screen.getByLabelText('เลือก กระจก'))
    fireEvent.change(screen.getByLabelText('จำนวน กระจก'), { target: { value: '7' } })
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(alert).toHaveBeenCalled())
    expect(alert.mock.calls[0][0]).toBe('จำนวน "กระจก" เกินที่เหลือใน BOQ ของเฟสนี้ (6)')
    expect(insertOf()).toBeUndefined()
  })
  it('no item ticked is rejected', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    await openAddForm('ผลิต')
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(alert).toHaveBeenCalled())
    expect(alert.mock.calls[0][0]).toMatch(/เลือกรายการ BOQ/)
    expect(insertOf()).toBeUndefined()
  })
  it('an item with nothing left in this phase is disabled', async () => {
    await openAddForm('ติดตั้ง') // b1 is fully used in ติดตั้ง (26/26)
    expect(screen.getByLabelText('เลือก กระจก').disabled).toBe(true)
    expect(screen.getByLabelText('เลือก ประตู').disabled).toBe(false)
    expect(screen.getByText(/1 กระจก — เหลือในเฟสนี้ 0 ตร\.ม\./)).toBeTruthy()
  })
  it('editing an existing BOQ card keeps the single-item select', async () => {
    render(<PhaseKanbanBoard site={site} canEdit onTasksChanged={() => {}} />)
    fireEvent.click(screen.getAllByText('ผลิต')[0])
    fireEvent.click(await screen.findByText('ผลิตกระจก'))
    const select = await screen.findByRole('combobox')
    expect(select.value).toBe('b1')
    expect(screen.queryByLabelText('เลือก กระจก')).toBeNull()
    expect(screen.getByText(/จำนวนในการ์ดนี้/).querySelector('input').value).toBe('20')
  })
})

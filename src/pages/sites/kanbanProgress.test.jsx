// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

// supabase: from(...) is a chainable query that resolves to `queryResult`;
// rpc(...) is a spy the tests set per case.
const rpc = vi.fn()
let queryResult = { data: [], error: null }
const calls = [] // [table, method, ...args]
const chain = (table) => {
  const q = {}
  ;['select', 'eq', 'order', 'in', 'is', 'not', 'limit', 'insert', 'upsert', 'update', 'delete'].forEach((m) => {
    q[m] = (...a) => { calls.push([table, m, ...a]); return q }
  })
  q.then = (resolve, reject) => Promise.resolve(queryResult).then(resolve, reject)
  return q
}
vi.mock('../../lib/supabase.js', () => ({ supabase: { rpc: (...a) => rpc(...a), from: (t) => chain(t) } }))
let mockRole = 'OWNER'
vi.mock('../../hooks/useUserRole.js', () => ({ useUserRole: () => ({ role: mockRole }) }))
const auditLog = vi.fn()
vi.mock('../../lib/audit.js', () => ({ auditLog: (...a) => auditLog(...a) }))

import { TaskCard, isStatusLeafTask, buildTaskSave } from './PhaseKanbanBoard.jsx'
import RecordProgressDialog from './RecordProgressDialog.jsx'
import SplitTaskDialog, { defaultSplitRows } from './SplitTaskDialog.jsx'
import PhaseManageModal from './PhaseManageModal.jsx'
import { resetProgressSchemaProbe } from '../../lib/progressSchema.js'

afterEach(() => { cleanup(); rpc.mockReset(); auditLog.mockReset(); queryResult = { data: [], error: null }; calls.length = 0; mockRole = 'OWNER'; resetProgressSchemaProbe() })

const statusCard = { id: 't1', name: 'ติดตั้งกระจก', status: 'not_started', progress_mode: 'status', weight_pts: 25, phase_task_workers: [] }
const qtyCard = { id: 't2', name: 'ติดตั้งบาน', status: 'in_progress', progress_mode: 'quantity', weight_pts: 40, planned_qty: 120, done_qty: 45, boq_item_id: 'b1', phase_task_workers: [] }

const card = (over = {}) => render(<TaskCard task={statusCard} canEdit role="PM" onEdit={() => {}} onRecord={() => {}} {...over} />)

describe('TaskCard', () => {
  it('shows the points pill', () => {
    card()
    expect(screen.getByText('25 แต้ม')).toBeTruthy()
  })
  it('a status leaf card is draggable when canEdit', () => {
    const { container } = card()
    expect(container.firstChild.getAttribute('draggable')).toBe('true')
  })
  it('a quantity card is not draggable and shows its meter', () => {
    const { container } = card({ task: qtyCard, unit: 'ชุด' })
    expect(container.firstChild.getAttribute('draggable')).toBe('false')
    expect(screen.getByText('45/120 ชุด · 37.5%')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('37.5')
  })
  it('a parent card is not draggable and lists its children with points and status', () => {
    const kids = [
      { id: 'c1', name: 'ชั้น 1', status: 'done', weight_pts: 15, parent_task_id: 't1' },
      { id: 'c2', name: 'ชั้น 2', status: 'not_started', weight_pts: 10, parent_task_id: 't1' },
    ]
    const { container } = card({ childTasks: kids })
    expect(container.firstChild.getAttribute('draggable')).toBe('false')
    expect(screen.getByText(/ชั้น 1/).textContent).toContain('15 แต้ม')
    expect(screen.getByText(/ชั้น 1/).textContent).toContain('เสร็จแล้ว')
    expect(screen.getByText(/ชั้น 2/).textContent).toContain('ยังไม่เริ่ม')
  })
  it('an ADMIN sees no "+ บันทึกยอด"', () => {
    card({ task: qtyCard, role: 'ADMIN' })
    expect(screen.queryByText('+ บันทึกยอด')).toBeNull()
  })
  it('a PM sees "+ บันทึกยอด" and it opens the record dialog without opening the edit form', () => {
    const onRecord = vi.fn(); const onEdit = vi.fn()
    card({ task: qtyCard, role: 'PM', onRecord, onEdit })
    fireEvent.click(screen.getByText('+ บันทึกยอด'))
    expect(onRecord).toHaveBeenCalledWith(qtyCard)
    expect(onEdit).not.toHaveBeenCalled()
  })
  it('a card without weight_pts (migration not applied) shows no pill and stays draggable', () => {
    const { container } = card({ task: { id: 'x', name: 'เก่า', status: 'done', phase_task_workers: [] } })
    expect(screen.queryByText(/แต้ม/)).toBeNull()
    expect(container.firstChild.getAttribute('draggable')).toBe('true')
  })
})

describe('isStatusLeafTask (drop guard)', () => {
  it('only status cards without children can be moved by drag', () => {
    expect(isStatusLeafTask(statusCard, {})).toBe(true)
    expect(isStatusLeafTask(qtyCard, {})).toBe(false)
    expect(isStatusLeafTask(statusCard, { t1: [{ id: 'c1' }] })).toBe(false)
  })
})

describe('buildTaskSave (card form)', () => {
  const draft = (over = {}) => ({ name: ' งาน ', zone: '', status: 'not_started', due_date: '', sort_order: 1,
    weight_pts: '20', progress_mode: 'status', boq_item_id: '', planned_qty: '', ...over })
  it('writes weight_pts, progress_mode, boq_item_id and planned_qty', () => {
    const { payload } = buildTaskSave({ draft: draft({ progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: '30', status: 'done' }), orig: null, progressReady: true, boqRemaining: () => 50 })
    expect(payload).toMatchObject({ name: 'งาน', weight_pts: 20, progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: 30, status: 'not_started' })
  })
  it('sends a change of วิธีนับ without a status change', () => {
    const orig = { id: 't1', status: 'done', progress_mode: 'status', weight_pts: 20 }
    const { payload } = buildTaskSave({ draft: draft({ status: 'in_progress', progress_mode: 'quantity', planned_qty: '10' }), orig, progressReady: true })
    expect(payload.progress_mode).toBe('quantity')
    expect('status' in payload).toBe(false)
  })
  it('sends status only when it changed on a status leaf', () => {
    const orig = { id: 't1', status: 'not_started', progress_mode: 'status', weight_pts: 20 }
    expect('status' in buildTaskSave({ draft: draft(), orig, progressReady: true }).payload).toBe(false)
    expect(buildTaskSave({ draft: draft({ status: 'done' }), orig, progressReady: true }).payload.status).toBe('done')
    expect('status' in buildTaskSave({ draft: draft({ status: 'done' }), orig, progressReady: true, childrenByParent: { t1: [{ id: 'c' }] } }).payload).toBe(false)
  })
  it('blocks a planned qty over what is left on the BOQ line', () => {
    expect(buildTaskSave({ draft: draft({ progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: '60' }), orig: null, progressReady: true, boqRemaining: () => 50 }).error)
      .toBe('จำนวนในการ์ดนี้เกินที่เหลือใน BOQ (50)')
  })
  it('sends no weight fields before the migration', () => {
    const { payload, weightFields } = buildTaskSave({ draft: draft(), orig: null, progressReady: false })
    expect(weightFields).toBeNull()
    expect('weight_pts' in payload).toBe(false)
  })
  it('no PLAN: a new card starts not_started, except in an issue phase', () => {
    expect(buildTaskSave({ draft: draft({ status: 'done' }), orig: null, progressReady: true, noPlan: true }).payload.status).toBe('not_started')
    expect(buildTaskSave({ draft: draft({ status: 'done' }), orig: null, progressReady: true, noPlan: true, issuePhase: true }).payload.status).toBe('done')
    expect(buildTaskSave({ draft: draft({ status: 'done' }), orig: null, progressReady: true }).payload.status).toBe('done')
  })
  it('a new card in an issue phase gets 0 points; an existing one keeps what was typed', () => {
    expect(buildTaskSave({ draft: draft(), orig: null, progressReady: true, issuePhase: true }).payload.weight_pts).toBe(0)
    const orig = { id: 't1', status: 'not_started', progress_mode: 'status', weight_pts: 20 }
    expect(buildTaskSave({ draft: draft(), orig, progressReady: true, issuePhase: true }).payload.weight_pts).toBe(20)
  })
})

describe('RecordProgressDialog', () => {
  const mount = (over = {}) => render(<RecordProgressDialog task={qtyCard} unit="ชุด" canManage onClose={() => {}} onSaved={() => {}} {...over} />)
  it('shows the remaining hint', () => {
    mount()
    expect(screen.getByText('ติดแล้ว 45 จาก 120 · เหลือ 75 · ใส่เกิน 75 ไม่ได้')).toBeTruthy()
  })
  it('blocks a qty over the remaining amount client-side', () => {
    mount()
    fireEvent.change(screen.getByLabelText('จำนวนที่ติดตั้ง'), { target: { value: '76' } })
    expect(screen.getByText('บันทึกยอด', { selector: 'button' }).disabled).toBe(true)
    fireEvent.click(screen.getByText('บันทึกยอด', { selector: 'button' }))
    expect(rpc).not.toHaveBeenCalled()
  })
  it('calls record_progress and closes', async () => {
    rpc.mockResolvedValue({ data: 'r9', error: null })
    const onSaved = vi.fn(); const onClose = vi.fn()
    mount({ onSaved, onClose })
    fireEvent.change(screen.getByLabelText('จำนวนที่ติดตั้ง'), { target: { value: '75' } })
    fireEvent.change(screen.getByLabelText('วันที่ทำงาน'), { target: { value: '2026-10-16' } })
    fireEvent.change(screen.getByLabelText('หมายเหตุ'), { target: { value: '  ชั้น 3  ' } })
    fireEvent.click(screen.getByText('บันทึกยอด', { selector: 'button' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(rpc).toHaveBeenCalledWith('record_progress', { p_task_id: 't2', p_qty: 75, p_work_date: '2026-10-16', p_note: 'ชั้น 3' })
    expect(onClose).toHaveBeenCalled()
  })
  it('shows the DB error verbatim', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'บันทึก PLAN v1 ของไซท์นี้ก่อนเริ่มบันทึกความคืบหน้า' } })
    mount()
    fireEvent.change(screen.getByLabelText('จำนวนที่ติดตั้ง'), { target: { value: '5' } })
    fireEvent.click(screen.getByText('บันทึกยอด', { selector: 'button' }))
    expect((await screen.findByRole('alert')).textContent).toBe('บันทึก PLAN v1 ของไซท์นี้ก่อนเริ่มบันทึกความคืบหน้า')
  })
  it('lists history, strikes cancelled rows and cancels with cancel_progress + audit', async () => {
    queryResult = { data: [
      { id: 'r1', qty: 30, work_date: '2026-10-15', note: null, created_by: 'pm@x.co', cancelled_at: null },
      { id: 'r0', qty: 20, work_date: '2026-10-14', note: 'ผิด', created_by: 'pm@x.co', cancelled_at: '2026-10-14T05:00:00Z' },
    ], error: null }
    rpc.mockResolvedValue({ data: null, error: null })
    const onSaved = vi.fn()
    mount({ onSaved })
    const cancelled = await screen.findByTestId('report-r0')
    expect(cancelled.style.textDecoration).toBe('line-through')
    expect(screen.getAllByText('ยกเลิกรายการ')).toHaveLength(1)
    fireEvent.click(screen.getByText('ยกเลิกรายการ'))
    fireEvent.click(screen.getByText('ยืนยันยกเลิก'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(rpc).toHaveBeenCalledWith('cancel_progress', { p_report_id: 'r1' })
    expect(auditLog).toHaveBeenCalledWith('progress_reports', 'r1', 'cancel', expect.objectContaining({ qty: 30 }), expect.any(Object))
  })
  it('hides the cancel button without canManage', async () => {
    queryResult = { data: [{ id: 'r1', qty: 30, work_date: '2026-10-15', cancelled_at: null }], error: null }
    mount({ canManage: false })
    await screen.findByTestId('report-r1')
    expect(screen.queryByText('ยกเลิกรายการ')).toBeNull()
  })
})

describe('SplitTaskDialog', () => {
  const parent = { id: 'p1', name: 'ติดตั้งกระจก', weight_pts: 25 }
  const mount = (over = {}) => render(<SplitTaskDialog task={parent} onClose={() => {}} onSaved={() => {}} {...over} />)
  it('defaults to two equal rows with the remainder on the first row', () => {
    expect(defaultSplitRows({ name: 'A', weight_pts: 10.01 }).map((r) => r.pts)).toEqual(['5.01', '5'])
    expect(defaultSplitRows({ name: 'A', weight_pts: 25 }).map((r) => r.pts)).toEqual(['12.5', '12.5'])
  })
  it('shows the live total and blocks save when it differs from the parent points', () => {
    mount()
    expect(screen.getByText('รวม 25 / 25 แต้ม ✓')).toBeTruthy()
    fireEvent.click(screen.getByText('+ เพิ่มแถว'))
    fireEvent.change(screen.getAllByLabelText('แต้ม')[2], { target: { value: '5' } })
    expect(screen.getByText('รวม 30 / 25 แต้ม')).toBeTruthy()
    expect(screen.getByText('แตกงาน', { selector: 'button' }).disabled).toBe(true)
    fireEvent.click(screen.getByText('แตกงาน', { selector: 'button' }))
    expect(rpc).not.toHaveBeenCalled()
  })
  it('calls split_task with the rows', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    const onSaved = vi.fn()
    mount({ onSaved })
    fireEvent.change(screen.getAllByLabelText('ชื่องานย่อย')[1], { target: { value: ' ชั้น 2 ' } })
    fireEvent.click(screen.getByText('แตกงาน', { selector: 'button' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(rpc).toHaveBeenCalledWith('split_task', { p_task_id: 'p1', p_children: [
      { name: 'ติดตั้งกระจก 1', weight_pts: 12.5 }, { name: 'ชั้น 2', weight_pts: 12.5 },
    ] })
  })
  it('shows the DB error verbatim', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'การ์ดนี้แตกงานแล้ว' } })
    mount()
    fireEvent.click(screen.getByText('แตกงาน', { selector: 'button' }))
    expect((await screen.findByRole('alert')).textContent).toBe('การ์ดนี้แตกงานแล้ว')
  })
})

describe('PhaseManageModal VO fields', () => {
  const site = { id: 's1', name: 'ไซท์ A' }
  const phases = [{ id: 'ph1', site_id: 's1', name: 'ติดตั้ง', sort_order: 1, status: 'not_started', billing_weight_pct: 100, is_vo: false, vo_ref: null }]
  const mount = (over = {}) => render(<PhaseManageModal site={site} phases={phases} onClose={() => {}} onSaved={() => {}} {...over} />)

  it('PM gets the VO toggle and VO number but never the VO value', async () => {
    mockRole = 'PM'
    mount()
    fireEvent.click(await screen.findByLabelText('งานเพิ่ม (VO)'))
    expect(screen.getByLabelText('เลขที่ VO')).toBeTruthy()
    expect(screen.queryByLabelText('มูลค่า VO (บาท)')).toBeNull()
  })
  it('OWNER saves is_vo/vo_ref on site_phases and the value to phase_vo_values only', async () => {
    const onSaved = vi.fn()
    mount({ onSaved })
    fireEvent.click(await screen.findByLabelText('งานเพิ่ม (VO)'))
    fireEvent.change(screen.getByLabelText('เลขที่ VO'), { target: { value: ' VO-01 ' } })
    fireEvent.change(screen.getByLabelText('มูลค่า VO (บาท)'), { target: { value: '50000' } })
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const phaseUpsert = calls.find((c) => c[0] === 'site_phases' && c[1] === 'upsert')
    expect(phaseUpsert[2][0]).toMatchObject({ id: 'ph1', is_vo: true, vo_ref: 'VO-01', billing_weight_pct: 0 })
    expect('vo_value' in phaseUpsert[2][0]).toBe(false)
    const voUpsert = calls.find((c) => c[0] === 'phase_vo_values' && c[1] === 'upsert')
    expect(voUpsert.slice(2)).toEqual([[{ phase_id: 'ph1', vo_value: 50000 }], { onConflict: 'phase_id' }])
  })
  it('shows no VO fields when the schema probe fails (migration not applied)', async () => {
    queryResult = { data: null, error: { message: 'column phase_tasks.progress_mode does not exist' } }
    mount({ phases: [{ id: 'ph1', site_id: 's1', name: 'ติดตั้ง', sort_order: 1, status: 'not_started', billing_weight_pct: 100 }] })
    await waitFor(() => expect(calls.some((c) => c[0] === 'phase_tasks' && c[1] === 'limit')).toBe(true))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByLabelText('งานเพิ่ม (VO)')).toBeNull()
  })
})

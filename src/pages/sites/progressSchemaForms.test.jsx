// @vitest-environment jsdom
// The schema probe (lib/progressSchema.js) gating the new Kanban card fields,
// and the VO fields of GanttView's inline phase form (the editor users use).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const calls = [] // [table, method, ...args]
let probeError = null
const resultFor = (table, ops) => {
  if (table === 'phase_tasks' && ops.includes('limit')) return { data: [], error: probeError }
  if (table === 'site_phases' && ops.includes('single')) return { data: { id: 'new1' }, error: null }
  return { data: [], error: null }
}
const chain = (table) => {
  const ops = []
  const q = {}
  ;['select', 'eq', 'neq', 'order', 'in', 'is', 'not', 'limit', 'insert', 'upsert', 'update', 'delete', 'single'].forEach((m) => {
    q[m] = (...a) => { ops.push(m); calls.push([table, m, ...a]); return q }
  })
  q.then = (resolve, reject) => Promise.resolve(resultFor(table, ops)).then(resolve, reject)
  return q
}
vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    from: (t) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) },
  },
}))
let mockRole = 'OWNER'
vi.mock('../../hooks/useUserRole.js', () => ({ useUserRole: () => ({ role: mockRole }) }))
vi.mock('../../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: { id: 'ten1' } }) }))
const auditCalls = []
vi.mock('../../lib/audit.js', () => ({ auditLog: async (...a) => { auditCalls.push(a) } }))

const phase = { id: 'p1', site_id: 's1', name: 'ติดตั้งกระจก', sort_order: 1, status: 'not_started', start_date: '2026-10-01', end_date: '2026-10-20', billing_weight_pct: 100, is_vo: false, vo_ref: null }
const q = (data) => ({ data, loading: false, error: null, refetch: async () => {} })
let mockPhases = [phase]
let mockTasks = []
let mockHasPlan = true
let mockPlans = [{ id: 'pl1', version: 1 }]
let mockBoq = []
vi.mock('../../hooks/useSupabase.js', () => ({
  useSitePhases: () => q(mockPhases),
  usePhaseTasks: () => q(mockTasks),
  useSiteHasPlan: () => ({ hasPlan: mockHasPlan, reload: () => {} }),
  useSubtasks: () => q([]),
  useWorkers: () => q([]),
  useSites: () => q([]),
  useBoqItems: () => q(mockBoq),
  useIncomes: () => q([]),
  useExpenses: () => q([]),
  useSitePlans: () => ({ plans: mockPlans, items: {}, loading: false, error: null, reload: () => {} }),
  useProgressReports: () => q([]),
  attachPmWorkerNames: async (rows) => rows || [],
}))

import { resetProgressSchemaProbe } from '../../lib/progressSchema.js'
import PhaseKanbanBoard from './PhaseKanbanBoard.jsx'
import GanttView from './GanttView.jsx'

const site = { id: 's1', name: 'ไซท์ A', site_number: 'S-1', contract_value: 1000000, start_date: '2026-10-01', end_date: '2026-10-20' }

beforeEach(() => {
  window.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
})
afterEach(() => {
  cleanup(); calls.length = 0; auditCalls.length = 0; probeError = null; mockRole = 'OWNER'; resetProgressSchemaProbe()
  mockPhases = [phase]; mockTasks = []; mockHasPlan = true; mockPlans = [{ id: 'pl1', version: 1 }]; mockBoq = []
})

describe('Kanban first card on an empty node (schema probe)', () => {
  const openNewCard = async () => {
    render(<PhaseKanbanBoard site={site} canEdit />)
    fireEvent.click(screen.getByText('ติดตั้งกระจก'))
    fireEvent.click(screen.getAllByText('+ เพิ่มงาน')[0])
  }
  it('asks BOQ or general (general picked) and has no points field when the probe succeeds, though no card is visible', async () => {
    await openNewCard()
    expect((await screen.findByLabelText('งานทั่วไป (ไม่นับ %)')).checked).toBe(true)
    expect(screen.getByLabelText('งาน BOQ (นับ %)').checked).toBe(false)
    expect(screen.queryByLabelText('แต้ม')).toBeNull()
    expect(screen.queryByText(/^แต้ม$/)).toBeNull()
    expect(screen.queryByText('รายการ BOQ')).toBeNull()
    expect(calls.some((c) => c[0] === 'phase_tasks' && c[1] === 'select' && c[2] === 'progress_mode')).toBe(true)
  })
  it('picking งาน BOQ shows the line, the qty and the auto-points note', async () => {
    await openNewCard()
    fireEvent.click(await screen.findByLabelText('งาน BOQ (นับ %)'))
    expect(screen.getByText('รายการ BOQ')).toBeTruthy()
    expect(screen.getByText(/จำนวนในการ์ดนี้/)).toBeTruthy()
    expect(screen.getByText('แต้มคิดให้อัตโนมัติจากมูลค่า ไม่ต้องกรอก')).toBeTruthy()
    expect(screen.queryByLabelText('แต้ม')).toBeNull()
  })
  it('hides the kind choice when the probe fails (migration not applied)', async () => {
    probeError = { message: 'column phase_tasks.progress_mode does not exist' }
    await openNewCard()
    await waitFor(() => expect(calls.some((c) => c[1] === 'limit')).toBe(true))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByLabelText('งาน BOQ (นับ %)')).toBeNull()
    expect(screen.queryByLabelText('งานทั่วไป (ไม่นับ %)')).toBeNull()
    expect(screen.queryByLabelText('แต้ม')).toBeNull()
  })
})

describe('GanttView phase form VO fields', () => {
  const mount = () => render(<GanttView sites={[site]} canEdit onPhasesChanged={() => {}} />)
  const voBox = () => screen.findByLabelText(/งานเพิ่ม \(VO\)/)

  it.each(['OWNER', 'ADMIN', 'PM'])('%s gets the VO toggle and VO number', async (role) => {
    mockRole = role
    mount()
    fireEvent.click(screen.getByText('+ เพิ่มขั้นตอน'))
    fireEvent.click(await voBox())
    expect(screen.getByPlaceholderText('เช่น VO-01')).toBeTruthy()
    const valueField = screen.queryByText('มูลค่า VO (บาท)')
    if (role === 'PM') expect(valueField).toBeNull()
    else expect(valueField).toBeTruthy()
  })

  it('a new VO phase saves weight 0 + is_vo/vo_ref on site_phases and the value only to phase_vo_values', async () => {
    mount()
    fireEvent.click(screen.getByText('+ เพิ่มขั้นตอน'))
    fireEvent.change(screen.getByPlaceholderText('ชื่อขั้นตอน'), { target: { value: 'VO ราวกันตก' } })
    fireEvent.click(await voBox())
    fireEvent.change(screen.getByPlaceholderText('เช่น VO-01'), { target: { value: 'VO-02' } })
    fireEvent.change(screen.getByText('มูลค่า VO (บาท)').querySelector('input'), { target: { value: '45000' } })
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(calls.some((c) => c[0] === 'phase_vo_values' && c[1] === 'upsert')).toBe(true))
    const insert = calls.find((c) => c[0] === 'site_phases' && c[1] === 'insert')[2]
    expect(insert).toMatchObject({ site_id: 's1', name: 'VO ราวกันตก', is_vo: true, vo_ref: 'VO-02', billing_weight_pct: 0 })
    expect('vo_value' in insert).toBe(false)
    const upsert = calls.find((c) => c[0] === 'phase_vo_values' && c[1] === 'upsert')
    expect(upsert.slice(2)).toEqual([[{ phase_id: 'new1', vo_value: 45000 }], { onConflict: 'phase_id' }])
  })

  it('PM saving a VO phase never touches phase_vo_values', async () => {
    mockRole = 'PM'
    mount()
    fireEvent.click(screen.getByText('+ เพิ่มขั้นตอน'))
    fireEvent.change(screen.getByPlaceholderText('ชื่อขั้นตอน'), { target: { value: 'VO 1' } })
    fireEvent.click(await voBox())
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(calls.some((c) => c[0] === 'site_phases' && c[1] === 'insert')).toBe(true))
    expect(calls.find((c) => c[0] === 'site_phases' && c[1] === 'insert')[2]).toMatchObject({ is_vo: true, billing_weight_pct: 0 })
    expect(calls.some((c) => c[0] === 'phase_vo_values' && c[1] !== 'select')).toBe(false)
  })

  it('shows no VO fields when the probe fails', async () => {
    probeError = { message: 'no column' }
    mount()
    fireEvent.click(screen.getByText('+ เพิ่มขั้นตอน'))
    await waitFor(() => expect(calls.some((c) => c[1] === 'limit')).toBe(true))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByLabelText(/งานเพิ่ม \(VO\)/)).toBeNull()
  })
})

const card = (over) => ({
  id: 't1', phase_id: 'p1', subtask_id: null, site_id: 's1', name: 'การ์ด 1', status: 'not_started', sort_order: 1,
  weight_pts: 0, progress_mode: 'status', planned_qty: null, done_qty: 0, boq_item_id: null,
  parent_task_id: null, issue_report_id: null, phase_task_workers: [], ...over,
})

describe('Kanban final-review rules', () => {
  const openPhase = (name = 'ติดตั้งกระจก') => {
    render(<PhaseKanbanBoard site={site} canEdit />)
    fireEvent.click(screen.getByText(name))
  }
  // with cards present the board opens on ทั้งหมด, which already lists the phase's cards
  const openBoard = () => render(<PhaseKanbanBoard site={site} canEdit />)
  const insertOf = () => calls.find((c) => c[0] === 'phase_tasks' && c[1] === 'insert')?.[2]

  it('no PLAN: a card added in the done column is saved not_started', async () => {
    mockHasPlan = false
    openPhase()
    fireEvent.click(screen.getAllByText('+ เพิ่มงาน')[2])
    fireEvent.change(screen.getByPlaceholderText('ชื่องาน'), { target: { value: 'งานใหม่' } })
    await screen.findByLabelText('งาน BOQ (นับ %)')
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(insertOf()).toBeTruthy())
    expect(insertOf()).toMatchObject({ name: 'งานใหม่', status: 'not_started' })
  })
  it('with a PLAN the done column is kept', async () => {
    openPhase()
    fireEvent.click(screen.getAllByText('+ เพิ่มงาน')[2])
    fireEvent.change(screen.getByPlaceholderText('ชื่องาน'), { target: { value: 'งานใหม่' } })
    await screen.findByLabelText('งาน BOQ (นับ %)')
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(insertOf()).toBeTruthy())
    expect(insertOf().status).toBe('done')
  })
  it('a new card in an issue phase keeps its column with no PLAN and sends no points', async () => {
    mockPhases = [phase, { ...phase, id: 'pi', name: 'แจ้งปัญหา', sort_order: 9, is_issue_phase: true }]
    mockHasPlan = false
    openPhase('แจ้งปัญหา')
    fireEvent.click(screen.getAllByText('+ เพิ่มงาน')[2])
    fireEvent.change(screen.getByPlaceholderText('ชื่องาน'), { target: { value: 'ซ่อมรั่ว' } })
    await screen.findByLabelText('งาน BOQ (นับ %)')
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(insertOf()).toBeTruthy())
    expect(insertOf()).toMatchObject({ phase_id: 'pi', progress_mode: 'status', status: 'done' })
    expect('weight_pts' in insertOf()).toBe(false)
  })
  it('a new BOQ card saves line + qty, starts not_started and sends no points', async () => {
    mockBoq = [{ id: 'b1', code: 'W-01', description: 'หน้าต่างบานเลื่อน', unit: 'ชุด', planned_qty: 120, sort_order: 1 }]
    openPhase()
    fireEvent.click(screen.getAllByText('+ เพิ่มงาน')[1])
    fireEvent.change(screen.getByPlaceholderText('ชื่องาน'), { target: { value: 'W-01 ชั้น 3' } })
    fireEvent.click(await screen.findByLabelText('งาน BOQ (นับ %)'))
    fireEvent.change(screen.getByText('รายการ BOQ').querySelector('select'), { target: { value: 'b1' } })
    fireEvent.change(screen.getByText(/จำนวนในการ์ดนี้/).querySelector('input'), { target: { value: '40' } })
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(insertOf()).toBeTruthy())
    expect(insertOf()).toMatchObject({ name: 'W-01 ชั้น 3', progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: 40, status: 'not_started' })
    expect('weight_pts' in insertOf()).toBe(false)
  })
  it('a BOQ card shows "BOQ · N แต้ม" and the board shows no "ยังไม่แจก" pill', async () => {
    mockTasks = [card({ progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: 10, weight_pts: 40 })]
    openBoard()
    expect(await screen.findByText('BOQ · 40 แต้ม')).toBeTruthy()
    expect(screen.queryByText(/ยังไม่แจก/)).toBeNull()
  })
  it.each([['ADMIN', true], ['PM', false], ['OWNER', false]])('%s: planned qty locked on a card with recorded quantity = %s', async (role, locked) => {
    mockRole = role
    mockTasks = [card({ progress_mode: 'quantity', planned_qty: 10, done_qty: 4, status: 'in_progress' })]
    openBoard()
    fireEvent.click(screen.getByText('การ์ด 1'))
    const qty = (await screen.findByText(/จำนวนในการ์ดนี้/)).querySelector('input')
    expect(qty.disabled).toBe(locked)
  })
  it('ADMIN can still edit planned qty while nothing is recorded', async () => {
    mockRole = 'ADMIN'
    mockTasks = [card({ progress_mode: 'quantity', planned_qty: 10, done_qty: 0 })]
    openBoard()
    fireEvent.click(screen.getByText('การ์ด 1'))
    expect((await screen.findByText(/จำนวนในการ์ดนี้/)).querySelector('input').disabled).toBe(false)
  })
  it.each(['not_started', 'in_progress', 'done'])('แตกงาน is offered on a %s general card', async (status) => {
    mockTasks = [card({ status })]
    openBoard()
    fireEvent.click(screen.getByText('การ์ด 1'))
    await screen.findByLabelText('งาน BOQ (นับ %)')
    expect(screen.getByText('✂️ แตกงาน')).toBeTruthy()
  })
  it('แตกงาน is not offered on a BOQ card', async () => {
    mockTasks = [card({ progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: 10, weight_pts: 100 })]
    openBoard()
    fireEvent.click(screen.getByText('การ์ด 1'))
    await screen.findByLabelText('งาน BOQ (นับ %)')
    expect(screen.queryByText('✂️ แตกงาน')).toBeNull()
  })
  it('the kind is locked on a split child and on a card with recorded quantity', async () => {
    mockTasks = [card({ id: 'tp', name: 'หลัก' }), card({ id: 'tc', name: 'การ์ดลูก', parent_task_id: 'tp', sort_order: 2 })]
    openBoard()
    fireEvent.click(screen.getByText('การ์ดลูก'))
    expect((await screen.findByLabelText('งาน BOQ (นับ %)')).disabled).toBe(true)
    cleanup()
    mockTasks = [card({ progress_mode: 'quantity', boq_item_id: 'b1', planned_qty: 10, done_qty: 2, status: 'in_progress' })]
    openBoard()
    fireEvent.click(screen.getByText('การ์ด 1'))
    expect((await screen.findByLabelText('งานทั่วไป (ไม่นับ %)')).disabled).toBe(true)
  })
  it('deleting a card writes an audit row with the card before', async () => {
    mockTasks = [card({ status: 'done' })]
    openBoard()
    fireEvent.click(screen.getByText('การ์ด 1'))
    fireEvent.click(await screen.findByText('🗑 ลบ'))
    const confirmBtn = await screen.findByRole('button', { name: /^ลบ$|ยืนยัน/ })
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(auditCalls.length).toBe(1))
    expect(auditCalls[0].slice(0, 3)).toEqual(['phase_tasks', 't1', 'delete'])
    expect(auditCalls[0][3]).toMatchObject({ name: 'การ์ด 1', status: 'done', weight_pts: 0, progress_mode: 'status' })
  })
})

describe('GanttView: no PLAN yet', () => {
  const addPhaseDone = async () => {
    render(<GanttView sites={[site]} canEdit onPhasesChanged={() => {}} />)
    fireEvent.click(screen.getByText('+ เพิ่มขั้นตอน'))
    fireEvent.change(screen.getByPlaceholderText('ชื่อขั้นตอน'), { target: { value: 'งานใหม่' } })
    const statusSelect = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'done'))
    fireEvent.change(statusSelect, { target: { value: 'done' } })
    await screen.findByLabelText(/งานเพิ่ม \(VO\)/)
    fireEvent.click(screen.getByText('✅ บันทึก'))
    await waitFor(() => expect(calls.some((c) => c[0] === 'site_phases' && c[1] === 'insert')).toBe(true))
    return calls.find((c) => c[0] === 'site_phases' && c[1] === 'insert')[2]
  }
  it('a new phase is saved not_started whatever status was picked', async () => {
    mockPlans = []
    expect((await addPhaseDone()).status).toBe('not_started')
  })
  it('with a PLAN the picked status is kept', async () => {
    expect((await addPhaseDone()).status).toBe('done')
  })
})

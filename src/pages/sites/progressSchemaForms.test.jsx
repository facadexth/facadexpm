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

const phase = { id: 'p1', site_id: 's1', name: 'ติดตั้งกระจก', sort_order: 1, status: 'not_started', start_date: '2026-10-01', end_date: '2026-10-20', billing_weight_pct: 100, is_vo: false, vo_ref: null }
const q = (data) => ({ data, loading: false, error: null, refetch: async () => {} })
vi.mock('../../hooks/useSupabase.js', () => ({
  useSitePhases: () => q([phase]),
  usePhaseTasks: () => q([]),
  useSubtasks: () => q([]),
  useWorkers: () => q([]),
  useSites: () => q([]),
  useBoqItems: () => q([]),
  useIncomes: () => q([]),
  useExpenses: () => q([]),
  useSitePlans: () => ({ plans: [{ id: 'pl1', version: 1 }], items: {}, loading: false, error: null, reload: () => {} }),
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
afterEach(() => { cleanup(); calls.length = 0; probeError = null; mockRole = 'OWNER'; resetProgressSchemaProbe() })

describe('Kanban first card on an empty node (schema probe)', () => {
  const openNewCard = async () => {
    render(<PhaseKanbanBoard site={site} canEdit />)
    fireEvent.click(screen.getByText('ติดตั้งกระจก'))
    fireEvent.click(screen.getAllByText('+ เพิ่มงาน')[0])
  }
  it('shows วิธีนับ and แต้ม (100 unallocated) when the probe succeeds, though no card is visible', async () => {
    await openNewCard()
    expect(await screen.findByText('วิธีนับ')).toBeTruthy()
    expect(screen.getByLabelText('แต้ม').value).toBe('100')
    expect(calls.some((c) => c[0] === 'phase_tasks' && c[1] === 'select' && c[2] === 'progress_mode')).toBe(true)
  })
  it('hides them when the probe fails (migration not applied)', async () => {
    probeError = { message: 'column phase_tasks.progress_mode does not exist' }
    await openNewCard()
    await waitFor(() => expect(calls.some((c) => c[1] === 'limit')).toBe(true))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('วิธีนับ')).toBeNull()
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

// @vitest-environment jsdom
// Gantt empty state: extra phase templates (FacadeX "งานอลูมิเนียม") appear as a choice only when
// the company has them; the chosen template's phases are what gets inserted.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const inserts = []
const chain = (table) => {
  const q = {}
  ;['select', 'eq', 'neq', 'order', 'in', 'is', 'not', 'limit', 'range', 'upsert', 'update', 'delete', 'single'].forEach((m) => { q[m] = () => q })
  q.insert = (rows) => { inserts.push({ table, rows }); return q }
  q.then = (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
  return q
}
vi.mock('../../lib/supabase.js', () => ({
  supabase: { from: (t) => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) },
  fmt: (n) => String(n),
}))
vi.mock('../../hooks/useUserRole.js', () => ({ useUserRole: () => ({ role: 'OWNER' }) }))
vi.mock('../../hooks/useTenant.js', () => ({ useTenant: () => ({ hasModuleAccess: () => false }) }))
vi.mock('./PhaseKanbanBoard.jsx', () => ({ default: () => null }))

const q = (data) => ({ data, loading: false, error: null, refetch: async () => {} })
let settings = {}
vi.mock('../../hooks/useSupabase.js', () => ({
  useSitePhases: () => q([]),
  usePhaseTasks: () => q([]),
  useSubtasks: () => q([]),
  useIncomes: () => q([]),
  useExpenses: () => q([]),
  useSitePlans: () => ({ plans: [], items: {}, loading: false, error: null, reload: () => {} }),
  useSiteProgressDaily: () => q([]),
  useSiteOverview: () => q(null),
  useAppSetting: (key) => q(settings[key] ?? ''),
}))

import GanttView from './GanttView.jsx'

const site = { id: 's1', name: 'ไซท์ใหม่', site_number: 'S-9' }
const ALU = JSON.stringify([{ key: 'alu', label: 'งานอลูมิเนียม', rows: [
  { name: 'ทำแบบเพื่อขออนุมัติ', weight: 0 }, { name: 'วงกบและบาน', weight: 40 }, { name: 'กระจก', weight: 40 }, { name: 'อุปกรณ์และเก็บงาน', weight: 20 },
] }])

beforeEach(() => { window.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) })
afterEach(() => { cleanup(); settings = {}; inserts.length = 0 })

const mount = () => render(<GanttView sites={[site]} canEdit onPhasesChanged={() => {}} />)

describe('Gantt template picker', () => {
  it('no extra templates: single button, no choice, inserts the company template', async () => {
    mount()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByText(/อลูมิเนียม/)).toBeNull()
    fireEvent.click(screen.getByText('+ เริ่มใช้ Gantt (เทมเพลตขั้นตอนงาน)'))
    await waitFor(() => expect(inserts).toHaveLength(1))
    expect(inserts[0].rows.map((r) => r.name)).toContain('ผลิต')
  })

  it('with the aluminium template: choose it and its phases + weights are inserted', async () => {
    settings = { phase_templates_extra: ALU }
    mount()
    expect(screen.getByRole('radio', { name: /มาตรฐาน/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: /งานอลูมิเนียม/ }))
    fireEvent.click(screen.getByText('+ เริ่มใช้ Gantt (งานอลูมิเนียม)'))
    await waitFor(() => expect(inserts).toHaveLength(1))
    expect(inserts[0].table).toBe('site_phases')
    expect(inserts[0].rows.map((r) => [r.name, r.billing_weight_pct, r.sort_order, r.site_id])).toEqual([
      ['ทำแบบเพื่อขออนุมัติ', 0, 1, 's1'], ['วงกบและบาน', 40, 2, 's1'], ['กระจก', 40, 3, 's1'], ['อุปกรณ์และเก็บงาน', 20, 4, 's1'],
    ])
  })
})

// @vitest-environment jsdom
// Task 8: the PLAN layer on the Gantt (ghost bars, delay tags, plan KPI) and
// the S-curve "งานจริง %" mode (PM sees only that mode).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'

let probeError = null
const chain = (table) => {
  const ops = []
  const q = {}
  ;['select', 'eq', 'neq', 'order', 'in', 'is', 'not', 'limit', 'range', 'insert', 'upsert', 'update', 'delete', 'single'].forEach((m) => {
    q[m] = () => { ops.push(m); return q }
  })
  q.then = (resolve, reject) => Promise.resolve(
    table === 'phase_tasks' && ops.includes('limit') ? { data: [], error: probeError } : { data: [], error: null },
  ).then(resolve, reject)
  return q
}
vi.mock('../../lib/supabase.js', () => ({
  supabase: { from: (t) => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) },
  fmt: (n) => String(n),
}))
let mockRole = 'OWNER'
vi.mock('../../hooks/useUserRole.js', () => ({ useUserRole: () => ({ role: mockRole }) }))
vi.mock('../../hooks/useTenant.js', () => ({ useTenant: () => ({ hasModuleAccess: () => false }) }))
vi.mock('recharts', async () => {
  const React = await import('react')
  const Box = ({ children }) => <div>{children}</div>
  const Nil = () => null
  // LineChart hands its rows to each Line (through fragments); a Line renders its name and calls a custom dot per row
  const withData = (children, data) => React.Children.map(children, (c) => {
    if (!React.isValidElement(c)) return c
    if (c.type === React.Fragment) return withData(c.props.children, data)
    return React.cloneElement(c, { chartData: data })
  })
  const Chart = ({ data, children }) => <div>{withData(children, data)}</div>
  const NamedLine = ({ name, dot, chartData }) => (
    <span data-testid="line">{name}{typeof dot === 'function' && (chartData || []).map((_, index) => dot({ index, cx: 10, cy: 10 }))}</span>
  )
  return { ResponsiveContainer: Box, LineChart: Chart, Line: NamedLine, XAxis: Nil, YAxis: Nil, CartesianGrid: Nil, Tooltip: Nil, Legend: Nil, ReferenceLine: Nil }
})
vi.mock('../../components/SiteOverviewContent.jsx', () => ({ default: () => null }))
vi.mock('./PhaseKanbanBoard.jsx', () => ({ default: () => null }))
vi.mock('./DailyReport.jsx', () => ({ default: () => null }))
vi.mock('./BoqTab.jsx', () => ({ default: () => null }))

const phases = [
  { id: 'p1', site_id: 's1', name: 'ผลิต', sort_order: 1, status: 'not_started', start_date: '2026-11-01', end_date: '2026-11-26', billing_weight_pct: 60, is_vo: false },
  { id: 'p2', site_id: 's1', name: 'ติดตั้ง', sort_order: 2, status: 'not_started', start_date: '2026-11-27', end_date: '2026-12-10', billing_weight_pct: 40, is_vo: false },
  { id: 'p3', site_id: 's1', name: 'งานเพิ่มหน้าต่าง', sort_order: 3, status: 'not_started', start_date: '2026-12-01', end_date: '2026-12-05', billing_weight_pct: 0, is_vo: true },
]
const plans = [
  { id: 'pl2', version: 2, note: 'เลื่อน', is_auto: false },
  { id: 'pl1', version: 1, note: 'auto', is_auto: true },
]
const items = {
  pl2: [
    { level: 'phase', ref_id: 'p1', parent_ref_id: null, name: 'ผลิต', start_date: '2026-11-01', end_date: '2026-11-20', weight: 60, is_vo: false },
    { level: 'phase', ref_id: 'p2', parent_ref_id: null, name: 'ติดตั้ง', start_date: '2026-11-21', end_date: '2026-12-15', weight: 40, is_vo: false },
  ],
  pl1: [
    { level: 'phase', ref_id: 'p1', parent_ref_id: null, name: 'ผลิต', start_date: '2026-11-01', end_date: '2026-11-26', weight: 100, is_vo: false },
  ],
}
const q = (data) => ({ data, loading: false, error: null, refetch: async () => {} })
let mockPlans = plans
let mockDaily = [{ day: '2026-11-05', contract_pct: 10 }]
vi.mock('../../hooks/useSupabase.js', () => ({
  useSitePhases: () => q(phases),
  usePhaseTasks: () => q([]),
  useSubtasks: () => q([]),
  useIncomes: () => q([]),
  useExpenses: () => q([]),
  useSitePlans: () => ({ plans: mockPlans, items, loading: false, error: null, reload: () => {} }),
  useSiteProgressDaily: () => q(mockDaily),
  useSiteOverview: () => q({ id: 's1', name: 'ไซท์ A', site_number: 'S-1', contract_value: 1000000 }),
  useAppSetting: () => q(''),
}))

import { resetProgressSchemaProbe, probeProgressSchema } from '../../lib/progressSchema.js'
import { planDelayTag, planPctSeries, planPctAt, workSeries } from './planLayer.js'
import GanttView from './GanttView.jsx'
import SCurveChart from './SCurveChart.jsx'
import SiteDetail from '../SiteDetail.jsx'

const site = { id: 's1', name: 'ไซท์ A', site_number: 'S-1', contract_value: 1000000 }

beforeEach(async () => {
  window.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  await probeProgressSchema() // schema ready
})
afterEach(() => { cleanup(); probeError = null; mockRole = 'OWNER'; mockPlans = plans; mockDaily = [{ day: '2026-11-05', contract_pct: 10 }]; resetProgressSchemaProbe() })

describe('planLayer maths', () => {
  it('delay tag: plan end 2026-11-20, current end 2026-11-26 -> ช้า 6 วัน (red)', () => {
    expect(planDelayTag('2026-11-26', '2026-11-20')).toEqual({ text: 'ช้า 6 วัน', tone: 'late' })
    expect(planDelayTag('2026-11-18', '2026-11-20')).toEqual({ text: 'เร็ว 2 วัน', tone: 'early' })
    expect(planDelayTag('2026-11-20', '2026-11-20')).toEqual({ text: 'ตรงแผน', tone: 'on' })
    expect(planDelayTag(null, '2026-11-20')).toBeNull()
  })
  it('plan series at contract value 100 equals the weights (non-VO phase items only)', () => {
    const series = planPctSeries([
      ...items.pl2,
      { level: 'phase', ref_id: 'v', start_date: '2026-11-01', end_date: '2026-11-02', weight: 50, is_vo: true },
      { level: 'subtask', ref_id: 'st', parent_ref_id: 'p1', start_date: '2026-11-01', end_date: '2026-11-02', weight: 100 },
    ])
    expect(planPctAt(series, '2026-11-20')).toBe(60)
    expect(planPctAt(series, '2026-12-15')).toBe(100)
    expect(planPctAt(series, '2027-01-01')).toBe(100)
    expect(planPctAt(series, '2026-10-01')).toBe(0)
  })
  it('work series: actual line from snapshots plus today live, none before the first snapshot or after today', () => {
    const rows = workSeries({ plan: [{ date: '2026-11-01', value: 0 }, { date: '2026-11-30', value: 100 }], daily: [{ day: '2026-11-05', contract_pct: 10 }], todayISO: '2026-11-10', livePct: 25 })
    const at = (d) => rows.find((r) => r.date === d)
    expect(at('2026-11-01').actual).toBeNull()
    expect(at('2026-11-05').actual).toBe(10)
    expect(at('2026-11-10').actual).toBe(25)
    expect(at('2026-11-30').actual).toBeNull()
    expect(at('2026-11-30').plan).toBe(100)
  })
})

describe('Gantt PLAN layer', () => {
  const mount = () => render(<GanttView sites={[site]} canEdit={false} onPhasesChanged={() => {}} />)
  const tags = () => screen.queryAllByTestId('plan-tag').map((n) => n.textContent)

  it('defaults to the latest version and draws a ghost bar per row in that version', async () => {
    mount()
    expect(await screen.findByRole('button', { name: 'v2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ปิด' })).toBeTruthy()
    expect(screen.getAllByTestId('plan-ghost')).toHaveLength(2)
    // p1: 11-26 vs plan 11-20; p2: 12-10 vs plan 12-15; p3 (VO) is not in v2
    expect(tags()).toEqual(['ช้า 6 วัน', 'เร็ว 5 วัน', 'ไม่มีใน PLAN'])
    expect(screen.getByText(/ตาม PLAN v2 วันนี้ควรได้/)).toBeTruthy()
  })
  it('switching to v1 redraws ghost bars for that version; ปิด hides the layer', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'v1' }))
    expect(screen.getAllByTestId('plan-ghost')).toHaveLength(1)
    expect(tags()).toEqual(['ตรงแผน', 'ไม่มีใน PLAN', 'ไม่มีใน PLAN'])
    fireEvent.click(screen.getByRole('button', { name: 'ปิด' }))
    expect(screen.queryAllByTestId('plan-ghost')).toHaveLength(0)
    expect(tags()).toEqual([])
    expect(screen.queryByText(/ตาม PLAN v/)).toBeNull()
  })
  it('no PLAN -> selector defaults to ปิด, no ghost bars', async () => {
    mockPlans = []
    mount()
    await screen.findByText('ไทม์ไลน์เฟสงาน')
    expect(screen.queryAllByTestId('plan-ghost')).toHaveLength(0)
  })
  it('schema not ready -> no selector', async () => {
    resetProgressSchemaProbe()
    probeError = { message: 'no column' }
    await probeProgressSchema()
    mount()
    await screen.findByText('ไทม์ไลน์เฟสงาน')
    expect(screen.queryByRole('button', { name: 'v2' })).toBeNull()
    expect(screen.queryAllByTestId('plan-ghost')).toHaveLength(0)
  })
})

describe('S-curve modes', () => {
  it('PM sees only งานจริง %, no money toggle or money lines', async () => {
    mockRole = 'PM'
    const { container } = render(<SCurveChart site={{ id: 's1', name: 'ไซท์ A' }} />)
    await screen.findAllByText(/งานจริง/)
    expect(screen.queryByRole('button', { name: 'เงิน' })).toBeNull()
    const lines = screen.getAllByTestId('line').map((n) => n.textContent)
    expect(lines.some((l) => l.includes('PLAN v2'))).toBe(true)
    expect(lines).toContain('งานจริง')
    expect(container.textContent).not.toMatch(/เบิกจริง|ต้นทุน|฿|บาท/)
  })
  it('OWNER keeps the money mode by default and can switch to งานจริง %', async () => {
    render(<SCurveChart site={{ id: 's1', name: 'ไซท์ A', contract_value: 1000000 }} />)
    const toWork = await screen.findByRole('button', { name: 'งานจริง %' })
    expect(screen.getAllByTestId('line').map((n) => n.textContent)).toContain('เบิกจริง')
    fireEvent.click(toWork)
    expect(screen.getAllByTestId('line').map((n) => n.textContent)).not.toContain('เบิกจริง')
  })
  it('OWNER before the migration sees the money chart only, no toggle', async () => {
    resetProgressSchemaProbe()
    probeError = { message: 'no column' }
    await probeProgressSchema()
    render(<SCurveChart site={{ id: 's1', name: 'ไซท์ A', contract_value: 1000000 }} />)
    await screen.findByText(/S-curve/)
    expect(screen.queryByRole('button', { name: 'งานจริง %' })).toBeNull()
  })
})

describe('one PLAN version for the Gantt and the S-curve (SiteDetail)', () => {
  const mount = async () => {
    render(<SiteDetail navState={{ siteId: 's1', siteName: 'ไซท์ A', tab: 'gantt' }} navigateTo={() => {}} />)
    await screen.findByRole('button', { name: 'v2' })
  }
  const lines = () => screen.getAllByTestId('line').map((n) => n.textContent)
  it('choosing v1 in the Gantt switches the S-curve plan line to PLAN v1', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'งานจริง %' }))
    expect(lines()).toContain('แผน (PLAN v2)')
    fireEvent.click(screen.getByRole('button', { name: 'v1' }))
    expect(lines()).toContain('แผน (PLAN v1)')
    expect(lines()).not.toContain('แผน (PLAN v2)')
  })
  it('PLAN ปิด in the Gantt -> the S-curve งานจริง mode has no plan line', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'งานจริง %' }))
    fireEvent.click(screen.getByRole('button', { name: 'ปิด' }))
    expect(lines()).toEqual(['งานจริง'])
    expect(screen.queryByText('ยังไม่มี PLAN จึงยังไม่มีเส้นแผน')).toBeNull()
  })
})

describe('S-curve actual point on day one', () => {
  it('a single actual point (today only) renders a visible dot', async () => {
    mockRole = 'PM'
    mockDaily = []
    render(<SCurveChart site={{ id: 's1', name: 'ไซท์ A' }} />)
    await screen.findAllByText(/งานจริง/)
    expect(screen.getAllByTestId('actual-last-dot')).toHaveLength(1)
  })
  it('with history, only the last actual point gets the dot', async () => {
    mockRole = 'PM'
    render(<SCurveChart site={{ id: 's1', name: 'ไซท์ A' }} />)
    await screen.findAllByText(/งานจริง/)
    expect(screen.getAllByTestId('actual-last-dot')).toHaveLength(1)
  })
})

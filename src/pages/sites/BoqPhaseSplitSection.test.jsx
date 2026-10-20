// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const rpc = vi.fn()
let splitRows = []
let splitError = null
vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    rpc: (...a) => rpc(...a),
    from: () => { const q = {}; ['select', 'in', 'order'].forEach((m) => { q[m] = () => q }); q.range = async () => ({ data: splitRows, error: splitError }); return q },
  },
}))
const refetchPhases = vi.fn(async () => {})
const phases = [
  { id: 'A', site_id: 's1', name: 'ผลิต', sort_order: 1 },
  { id: 'B', site_id: 's1', name: 'ติดตั้ง', sort_order: 2 },
  { id: 'V', site_id: 's1', name: 'งานเพิ่ม', sort_order: 3, is_vo: true },
  { id: 'Z', site_id: 's2', name: 'อื่น', sort_order: 1 },
]
vi.mock('../../hooks/useSupabase.js', () => ({
  useSitePhases: () => ({ data: phases, loading: false, error: null, refetch: refetchPhases }),
}))
let mockReady = true
vi.mock('../../lib/progressSchema.js', () => ({ useProgressSchemaReady: () => mockReady }))

import BoqPhaseSplitSection from './BoqPhaseSplitSection.jsx'

const boq = [
  { id: 'b1', code: '1', description: 'กระจก', unit: 'ตร.ม.', planned_qty: 50, sort_order: 1 },
  { id: 'b2', code: '2', description: 'ประตู', unit: 'ชุด', planned_qty: 2, sort_order: 2 },
]
const defaults = [{ phase_id: 'A', pct: 40 }, { phase_id: 'B', pct: 60 }, { phase_id: 'V', pct: 0 }]
const rpcDefaults = (extra = {}) => rpc.mockImplementation(async (name) => {
  if (name === 'boq_phase_split_defaults') return { data: defaults, error: null }
  if (extra[name]) return extra[name]
  return { data: null, error: null }
})
const mount = (over = {}) => render(<BoqPhaseSplitSection siteId="s1" boq={boq} sharesPct={{ b1: 70, b2: 30 }} canManage onError={() => {}} onSaved={() => {}} {...over} />)
const cell = (item, phase) => screen.getByLabelText(`${item} ${phase} %`)

afterEach(() => { cleanup(); rpc.mockReset(); refetchPhases.mockClear(); splitRows = []; splitError = null; mockReady = true })

describe('BoqPhaseSplitSection', () => {
  it('one row per item, a column per phase of this site (VO greyed), defaults from the template RPC, no baht', async () => {
    rpcDefaults()
    mount()
    await waitFor(() => expect(screen.getByTestId('split-row-b1')).toBeTruthy())
    expect(rpc).toHaveBeenCalledWith('boq_phase_split_defaults', { p_site: 's1' })
    expect(screen.getAllByText(/ผลิต|ติดตั้ง|งานเพิ่ม \(VO\)/).length).toBeGreaterThanOrEqual(3)
    expect(screen.queryByText('อื่น')).toBeNull()
    expect(cell('กระจก', 'ผลิต').value).toBe('40')
    expect(cell('ประตู', 'ติดตั้ง').value).toBe('60')
    expect(cell('ประตู', 'งานเพิ่ม').value).toBe('0')
    expect(screen.getByTestId('split-row-b1').querySelector('[data-col="pts"]').textContent).toBe('70')
    expect(screen.getByTestId('split-row-b1').querySelector('[data-col="row-total"]').textContent).toBe('100 ✓')
    expect(screen.getByTestId('split-row-b1').getAttribute('data-custom')).toBe('false')
    expect(document.body.textContent).not.toMatch(/บาท|฿|(?<!เสนอ)ราคา|ต่อหน่วย|มูลค่า/)
  })
  it('footer shows the live derived weights (shares 70/30)', async () => {
    rpcDefaults()
    mount()
    await waitFor(() => expect(screen.getByTestId('split-footer')).toBeTruthy())
    const f = screen.getByTestId('split-footer')
    expect(f.querySelector('[data-weight="A"]').textContent).toBe('40')
    expect(f.querySelector('[data-weight="B"]').textContent).toBe('60')
    fireEvent.change(cell('กระจก', 'ผลิต'), { target: { value: '100' } })
    fireEvent.change(cell('กระจก', 'ติดตั้ง'), { target: { value: '0' } })
    // raw A = .7*100 + .3*40 = 82, B = .3*60 = 18
    expect(f.querySelector('[data-weight="A"]').textContent).toBe('82')
    expect(f.querySelector('[data-weight="B"]').textContent).toBe('18')
    expect(f.querySelector('[data-weight="V"]').textContent).toBe('0')
  })
  it('a cell that differs from the default is marked custom and the row gets the แก้เอง tag', async () => {
    rpcDefaults()
    mount()
    await waitFor(() => expect(screen.getByTestId('split-row-b1')).toBeTruthy())
    fireEvent.change(cell('กระจก', 'ผลิต'), { target: { value: '50' } })
    expect(cell('กระจก', 'ผลิต').getAttribute('data-custom')).toBe('true')
    expect(screen.getByTestId('split-row-b1').querySelector('[data-tag="custom"]').textContent).toBe('แก้เอง')
    expect(screen.getByTestId('split-row-b2').querySelector('[data-tag="custom"]')).toBeNull()
    expect(screen.getByTestId('split-row-b1').querySelector('[data-col="row-total"]').textContent).toBe('110 ✗')
    expect(screen.getByText('บันทึก').disabled).toBe(true)
  })
  it('saved rows win over the defaults', async () => {
    splitRows = [{ boq_item_id: 'b1', phase_id: 'A', pct: '25' }, { boq_item_id: 'b1', phase_id: 'B', pct: 75 }, { boq_item_id: 'b2', phase_id: 'A', pct: 40 }, { boq_item_id: 'b2', phase_id: 'B', pct: 60 }]
    rpcDefaults()
    mount()
    await waitFor(() => expect(cell('กระจก', 'ผลิต').value).toBe('25'))
    expect(cell('กระจก', 'ผลิต').getAttribute('data-custom')).toBe('true')
    expect(screen.getByText(/น้ำหนักเฟสใน Gantt คิดจากตารางนี้/)).toBeTruthy()
  })
  it('save sends every cell to save_boq_phase_splits and refetches phases', async () => {
    const onSaved = vi.fn()
    rpcDefaults({ save_boq_phase_splits: { data: { ok: true, phase_weights: [{ phase_id: 'A', weight: 46 }, { phase_id: 'B', weight: 54 }, { phase_id: 'V', weight: 0 }] }, error: null } })
    mount({ onSaved })
    await waitFor(() => expect(screen.getByTestId('split-row-b1')).toBeTruthy())
    fireEvent.change(cell('กระจก', 'ผลิต'), { target: { value: '50' } })
    fireEvent.change(cell('กระจก', 'ติดตั้ง'), { target: { value: '50' } })
    fireEvent.click(screen.getByText('บันทึก'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const call = rpc.mock.calls.find((c) => c[0] === 'save_boq_phase_splits')
    expect(call[1].p_site).toBe('s1')
    expect(call[1].p_rows).toEqual([
      { boq_item_id: 'b1', phase_id: 'A', pct: 50 }, { boq_item_id: 'b1', phase_id: 'B', pct: 50 }, { boq_item_id: 'b1', phase_id: 'V', pct: 0 },
      { boq_item_id: 'b2', phase_id: 'A', pct: 40 }, { boq_item_id: 'b2', phase_id: 'B', pct: 60 }, { boq_item_id: 'b2', phase_id: 'V', pct: 0 },
    ])
    expect(refetchPhases).toHaveBeenCalled()
    expect(screen.getByText(/บันทึกแล้ว · น้ำหนักเฟส: ผลิต 46% · ติดตั้ง 54%/)).toBeTruthy()
  })
  it('an RPC error goes to onError verbatim', async () => {
    const onError = vi.fn()
    rpcDefaults({ save_boq_phase_splits: { data: null, error: { message: 'รายการ 1 รวมได้ 110 ต้องได้ 100' } } })
    mount({ onError })
    await waitFor(() => expect(screen.getByTestId('split-row-b1')).toBeTruthy())
    fireEvent.change(cell('กระจก', 'ผลิต'), { target: { value: '30' } })
    fireEvent.change(cell('กระจก', 'ติดตั้ง'), { target: { value: '70' } })
    fireEvent.click(screen.getByText('บันทึก'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('รายการ 1 รวมได้ 110 ต้องได้ 100'))
  })
  it('defaults RPC failing -> empty matrix (all 0) with the note โหลดค่าแม่แบบไม่ได้, still editable', async () => {
    rpc.mockImplementation(async (name) => (name === 'boq_phase_split_defaults' ? { data: null, error: { message: 'boom' } } : { data: null, error: null }))
    mount()
    await waitFor(() => expect(screen.getByTestId('split-row-b1')).toBeTruthy())
    expect(cell('กระจก', 'ผลิต').value).toBe('0')
    expect(cell('ประตู', 'ติดตั้ง').value).toBe('0')
    expect(screen.getByText(/โหลดค่าแม่แบบไม่ได้/)).toBeTruthy()
    expect(screen.getByTestId('split-row-b1').querySelector('[data-col="row-total"]').textContent).toBe('0 ✗')
    expect(screen.getByTestId('split-row-b1').getAttribute('data-custom')).toBe('false')
  })
  it('read-only without canManage: no save button, inputs read only', async () => {
    rpcDefaults()
    mount({ canManage: false })
    await waitFor(() => expect(screen.getByTestId('split-row-b1')).toBeTruthy())
    expect(screen.queryByText('บันทึก')).toBeNull()
    expect(cell('กระจก', 'ผลิต').readOnly).toBe(true)
    expect(screen.getByText(/ดูอย่างเดียว/)).toBeTruthy()
  })
  it('draws nothing when the table is not there yet (migration not applied) or before the schema probe', async () => {
    splitError = { message: 'relation "boq_phase_splits" does not exist' }
    rpcDefaults()
    const { container } = mount()
    await new Promise((r) => setTimeout(r, 10))
    expect(container.querySelector('[data-testid="boq-phase-split"]')).toBeNull()
    cleanup()
    rpc.mockClear()
    splitError = null; mockReady = false
    const r2 = mount()
    await new Promise((r) => setTimeout(r, 10))
    expect(r2.container.querySelector('[data-testid="boq-phase-split"]')).toBeNull()
    expect(rpc).not.toHaveBeenCalledWith('boq_phase_split_defaults', expect.anything())
  })
})

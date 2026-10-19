// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

// supabase: line_site_photos with .is('task_id', null) is the unassigned tray query;
// every other query resolves to the assigned-count rows. Calls are recorded.
const calls = []
const seed = [
  { id: 'ph1', photo_path: 'a.jpg', worker_id: 'w1', workers: { name: 'สมชาย', nickname: 'ชาย' }, created_at: '2026-10-19T01:00:00Z' },
  { id: 'ph2', photo_path: 'b.jpg', worker_id: 'w1', workers: { name: 'สมหญิง', nickname: null }, created_at: '2026-10-19T02:00:00Z' },
  { id: 'ph3', photo_path: 'c.jpg', worker_id: 'w1', workers: { name: 'สมศักดิ์', nickname: null }, created_at: '2026-10-19T03:00:00Z' },
]
let unassigned = seed
const chain = (table) => {
  const q = { _unassigned: false, _upd: false }
  ;['select', 'eq', 'order', 'in', 'not', 'limit', 'insert', 'upsert', 'update', 'delete'].forEach((m) => {
    q[m] = (...a) => {
      calls.push([table, m, ...a])
      if (m === 'update') q._upd = true
      // an update by id takes the photo out of the (mock) unassigned tray, like the real DB would
      if (q._upd && (m === 'eq' || m === 'in') && a[0] === 'id') {
        const ids = [].concat(a[1])
        unassigned = unassigned.filter((p) => !ids.includes(p.id))
      }
      return q
    }
  })
  q.is = (...a) => { calls.push([table, 'is', ...a]); q._unassigned = true; return q }
  q.then = (resolve, reject) => Promise.resolve({ data: table === 'line_site_photos' && q._unassigned ? unassigned : [], error: null }).then(resolve, reject)
  return q
}
vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: 'w1' }),
    from: (t) => chain(t),
    storage: { from: () => ({ createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://img/${p}` })) }) }) },
  },
}))
vi.mock('../../hooks/useUserRole.js', () => ({ useUserRole: () => ({ role: 'OWNER' }) }))
vi.mock('../../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: { id: 'tn1' } }) }))
vi.mock('../../lib/progressSchema.js', () => ({ useProgressSchemaReady: () => true }))
vi.mock('../../lib/audit.js', () => ({ auditLog: vi.fn() }))

const q = (data) => ({ data, loading: false, error: null, refetch: async () => {} })
const sites = [
  { id: 's1', site_number: 'S-001', name: 'ไซต์ปัจจุบัน', status: 'Ongoing', client_display_name: 'ลูกค้า ก' },
  { id: 's2', site_number: 'S-002', name: 'โครงการ บางนา', status: 'Ongoing', client_display_name: 'บริษัท ทองดี' },
  { id: 's3', site_number: 'S-003', name: 'โครงการ รังสิต', status: 'Ongoing', client_display_name: 'คุณสมศรี' },
  { id: 's4', site_number: 'S-004', name: 'โครงการ ปิดงาน', status: 'Completed', client_display_name: 'ลูกค้า ข' },
]
vi.mock('../../hooks/useSupabase.js', () => ({
  useSitePhases: () => q([{ id: 'p1', site_id: 's1', name: 'ติดตั้ง', sort_order: 1 }]),
  usePhaseTasks: () => q([{ id: 't1', phase_id: 'p1', subtask_id: null, name: 'ติดตั้งกระจก', status: 'not_started', progress_mode: 'status', weight_pts: 0, phase_task_workers: [] }]),
  useWorkers: () => q([]),
  useSubtasks: () => q([]),
  useSites: () => q(sites),
  useBoqItems: () => q([]),
  useSiteHasPlan: () => ({ hasPlan: true }),
  attachPmWorkerNames: async (rows) => rows || [],
}))

import PhaseKanbanBoard, { ongoingSiteOptions } from './PhaseKanbanBoard.jsx'

const site = { id: 's1', name: 'ไซต์ปัจจุบัน' }
const BANNER = 'เลือกรูปแล้ว 1 รูป — แตะการ์ดที่จะใส่รูป (หรือ แตะรูปอีกครั้งเพื่อยกเลิก)'

beforeEach(() => { unassigned = seed; try { localStorage.clear() } catch { /* ignore */ } })
afterEach(() => { cleanup(); calls.length = 0 })

const board = async (props = {}) => {
  const r = render(<PhaseKanbanBoard site={site} canEdit onTasksChanged={() => {}} {...props} />)
  await waitFor(() => expect(screen.getAllByTestId('photo-thumb').length).toBe(3))
  return r
}

describe('photo tray', () => {
  it('renders the photos in ONE non-wrapping row with the count, inside a sticky block', async () => {
    await board()
    expect(screen.getByText('📷 รูปที่รอมอบหมาย (3)')).toBeTruthy()
    expect(screen.getByText('ลากรูปไปวางบนการ์ด หรือ แตะรูป → แตะการ์ด')).toBeTruthy()
    const row = screen.getByTestId('photo-tray-row')
    expect(row.style.flexWrap).toBe('nowrap')
    expect(row.style.overflowX).toBe('auto')
    expect(screen.getByTestId('photo-tray-sticky').style.position).toBe('sticky')
    expect(screen.getAllByAltText('').every((i) => i.style.width === '72px' && i.style.height === '72px')).toBe(true)
    // still the 40-photo limit and the same unassigned query
    expect(calls.some((c) => c[0] === 'line_site_photos' && c[1] === 'limit' && c[2] === 40)).toBe(true)
  })

  it('tap a photo -> banner + cards invite a tap -> tapping a card assigns (photoId, taskId) and clears', async () => {
    await board()
    expect(screen.queryByText(BANNER)).toBeNull()
    fireEvent.click(screen.getAllByTestId('photo-thumb')[1])
    expect(screen.getByText(BANNER)).toBeTruthy()
    expect(screen.getAllByTestId('photo-thumb')[1].querySelector('img').style.border).toContain('3px')
    expect(screen.getByText('แตะเพื่อใส่รูปที่เลือก')).toBeTruthy()
    fireEvent.click(screen.getByText('ติดตั้งกระจก'))
    await waitFor(() => expect(calls.some((c) => c[0] === 'line_site_photos' && c[1] === 'update' && c[2].task_id === 't1')).toBe(true))
    expect(calls.some((c) => c[0] === 'line_site_photos' && c[1] === 'eq' && c[2] === 'id' && c[3] === 'ph2')).toBe(true)
    expect(screen.queryByText(BANNER)).toBeNull()
    expect(screen.queryByText('แตะเพื่อใส่รูปที่เลือก')).toBeNull()
  })

  it('while a photo is selected, tapping a card does not open its edit panel', async () => {
    await board()
    fireEvent.click(screen.getAllByTestId('photo-thumb')[0])
    fireEvent.click(screen.getByText('ติดตั้งกระจก'))
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull())
    expect(screen.queryByText('✅ บันทึก')).toBeNull() // TaskEditPanel not opened
  })

  it('without a selected photo a card tap still opens the normal edit panel', async () => {
    await board()
    fireEvent.click(screen.getByText('ติดตั้งกระจก'))
    expect(screen.queryByText('แตะเพื่อใส่รูปที่เลือก')).toBeNull()
    expect(calls.some((c) => c[1] === 'update')).toBe(false)
    expect(screen.getByText('✅ บันทึก')).toBeTruthy() // the edit panel is open
  })

  it('tapping the same photo again deselects it', async () => {
    await board()
    const thumb = screen.getAllByTestId('photo-thumb')[0]
    fireEvent.click(thumb)
    expect(screen.getByText(BANNER)).toBeTruthy()
    fireEvent.click(thumb)
    expect(screen.queryByText(BANNER)).toBeNull()
    expect(screen.queryByText('แตะเพื่อใส่รูปที่เลือก')).toBeNull()
  })

  it('the banner has ✕ ยกเลิก that clears the selection, also when the tray is collapsed', async () => {
    await board()
    fireEvent.click(screen.getAllByTestId('photo-thumb')[0])
    fireEvent.click(screen.getByText('ซ่อนแถบ ▲'))
    expect(screen.getByText(BANNER)).toBeTruthy()
    fireEvent.click(screen.getByText('✕ ยกเลิก'))
    expect(screen.queryByText(BANNER)).toBeNull()
    expect(screen.queryByText('แตะเพื่อใส่รูปที่เลือก')).toBeNull()
  })

  it('stale selection: tap A, drag-assign A, then tap the card -> no second update', async () => {
    await board()
    fireEvent.click(screen.getAllByTestId('photo-thumb')[0]) // ph1 tapped
    const card = screen.getByText('ติดตั้งกระจก')
    const dt = { types: ['application/x-line-site-photo-id'], getData: () => 'ph1' }
    fireEvent.drop(card, { dataTransfer: dt })
    await waitFor(() => expect(screen.getAllByTestId('photo-thumb')).toHaveLength(2))
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull())
    const updates = () => calls.filter((c) => c[0] === 'line_site_photos' && c[1] === 'update').length
    expect(updates()).toBe(1)
    fireEvent.click(screen.getByText('ติดตั้งกระจก'))
    expect(updates()).toBe(1)
  })

  it('stale selection: tap A, move A to another site via the picker -> no task update afterwards', async () => {
    await board()
    fireEvent.click(screen.getAllByTestId('photo-thumb')[0]) // ph1 tapped AND ticked
    fireEvent.click(screen.getAllByLabelText('เลือกหลายรูป')[0])
    fireEvent.click(screen.getByText('📍 ย้ายไซต์'))
    fireEvent.click(screen.getByText('ค้นหาไซต์ปลายทาง (รหัส / ชื่อ / ลูกค้า)'))
    fireEvent.click(screen.getByText('S-002 · โครงการ บางนา · Ongoing'))
    fireEvent.click(screen.getByText('ย้ายไป โครงการ บางนา'))
    await waitFor(() => expect(screen.getAllByTestId('photo-thumb')).toHaveLength(2))
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull())
    const before = calls.filter((c) => c[1] === 'update').length
    fireEvent.click(screen.getByText('ติดตั้งกระจก'))
    expect(calls.filter((c) => c[1] === 'update').length).toBe(before)
    expect(calls.some((c) => c[1] === 'update' && c[2].task_id === 't1')).toBe(false)
  })

  it('the multi-select checkbox is independent of tap-to-assign', async () => {
    await board()
    fireEvent.click(screen.getAllByLabelText('เลือกหลายรูป')[0])
    expect(screen.getByText('เลือกไว้ 1 รูป')).toBeTruthy()
    expect(screen.queryByText(BANNER)).toBeNull()
  })

  it('the ⤢ button opens the preview WITHOUT selecting; เลือกรูปนี้ selects and closes it', async () => {
    await board()
    const btns = screen.getAllByLabelText('ดูรูปขนาดใหญ่')
    expect(btns).toHaveLength(3)
    expect(btns[0].style.minWidth).toBe('26px')
    fireEvent.click(btns[1])
    expect(screen.getByText('📷 รูป 2 / 3')).toBeTruthy()
    expect(screen.queryByText(BANNER)).toBeNull() // not selected by opening
    fireEvent.click(screen.getByLabelText('รูปถัดไป'))
    expect(screen.getByText('📷 รูป 3 / 3')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('รูปก่อนหน้า'))
    fireEvent.click(screen.getByText('เลือกรูปนี้'))
    expect(screen.queryByText(/📷 รูป \d \/ 3/)).toBeNull() // lightbox closed
    expect(screen.getByText(BANNER)).toBeTruthy()
    expect(screen.getAllByTestId('photo-thumb')[1].querySelector('img').style.border).toContain('3px')
  })

  it('the collapse toggle hides the thumbnails, remembers it, and comes back', async () => {
    const { unmount } = await board()
    fireEvent.click(screen.getByText('ซ่อนแถบ ▲'))
    expect(screen.queryByTestId('photo-tray-row')).toBeNull()
    expect(screen.getByText('📷 รูปที่รอมอบหมาย (3)')).toBeTruthy() // header stays
    expect(localStorage.getItem('kanbanPhotoTrayCollapsed')).toBe('1')
    unmount()
    render(<PhaseKanbanBoard site={site} canEdit onTasksChanged={() => {}} />)
    await waitFor(() => expect(screen.getByText('แสดงแถบ ▼')).toBeTruthy())
    expect(screen.queryByTestId('photo-tray-row')).toBeNull()
    fireEvent.click(screen.getByText('แสดงแถบ ▼'))
    expect(screen.getByTestId('photo-tray-row')).toBeTruthy()
  })
})

describe('move to another site picker', () => {
  it('ongoingSiteOptions: Ongoing only, never the current site, label code · name · Ongoing', () => {
    const opts = ongoingSiteOptions(sites, 's1')
    expect(opts.map((o) => o.value)).toEqual(['s2', 's3'])
    expect(opts[0].label).toBe('S-002 · โครงการ บางนา · Ongoing')
  })

  const openPicker = async () => {
    await board()
    fireEvent.click(screen.getAllByLabelText('เลือกหลายรูป')[0])
    fireEvent.click(screen.getByText('📍 ย้ายไซต์'))
    fireEvent.click(screen.getByText('ค้นหาไซต์ปลายทาง (รหัส / ชื่อ / ลูกค้า)'))
  }

  it('lists only other Ongoing sites; search filters by name, code and client; confirm moves', async () => {
    await openPicker()
    expect(screen.getByText('S-002 · โครงการ บางนา · Ongoing')).toBeTruthy()
    expect(screen.getByText('S-003 · โครงการ รังสิต · Ongoing')).toBeTruthy()
    expect(screen.queryByText(/ไซต์ปัจจุบัน/)).toBeNull()
    expect(screen.queryByText(/ปิดงาน/)).toBeNull()

    const box = screen.getByPlaceholderText('พิมพ์เพื่อค้นหา...')
    fireEvent.change(box, { target: { value: 'รังสิต' } })
    expect(screen.queryByText(/บางนา/)).toBeNull()
    expect(screen.getByText(/รังสิต/)).toBeTruthy()
    fireEvent.change(box, { target: { value: 's-002' } })
    expect(screen.getByText(/บางนา/)).toBeTruthy()
    expect(screen.queryByText(/รังสิต/)).toBeNull()
    fireEvent.change(box, { target: { value: 'ทองดี' } })
    expect(screen.getByText(/บางนา/)).toBeTruthy()

    fireEvent.click(screen.getByText('S-002 · โครงการ บางนา · Ongoing'))
    const confirm = screen.getByText('ย้ายไป โครงการ บางนา')
    fireEvent.click(confirm)
    await waitFor(() => expect(calls.some((c) => c[0] === 'line_site_photos' && c[1] === 'update' && c[2].site_id === 's2' && c[2].task_id === null)).toBe(true))
  })

  it('the confirm button is disabled until a site is picked', async () => {
    await openPicker()
    expect(screen.getByText('ย้ายไป...').disabled).toBe(true)
  })
})

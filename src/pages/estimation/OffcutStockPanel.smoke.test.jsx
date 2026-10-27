// @vitest-environment jsdom
// Offcut stock panel: only in-stock offcuts of this project's profile+finish groups, what the plan does with each,
// the QR-highlighted row, and the inline "ทิ้ง" confirm (no window.confirm) with the thrown Thai error shown.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

const discardOffcut = vi.fn()
vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmtDate: () => '20 ต.ค. 2569' }))
vi.mock('../../hooks/useEstimation2b.js', () => ({ discardOffcut: (...a) => discardOffcut(...a) }))
const { default: OffcutStockPanel } = await import('./OffcutStockPanel.jsx')

afterEach(() => { cleanup(); discardOffcut.mockReset() })

const off = (id, code, o = {}) => ({ id, code, profile_id: 'A', finish_id: 'F', length_m: 1.2, status: 'in_stock', source_project_id: 'p0', created_at: '2026-10-20T03:00:00Z', ...o })
const offcuts = [
  off('o1', 'OC-0001'),
  off('o2', 'OC-0002', { length_m: 0.9 }),
  off('o3', 'OC-0003', { finish_id: 'G' }),          // same profile, another finish: not this project's
  off('o4', 'OC-0004', { profile_id: 'B' }),          // another profile
  off('o5', 'OC-0005', { status: 'used' }),
  off('o6', 'OC-0006', { status: 'discarded' }),
]
const groupInfo = { 'A|F': { profile_id: 'A', finish_id: 'F', die_no: 'F7980', name: 'กรอบบาน', finish_name: 'อบขาว' } }
const pc = (len, no) => ({ length_m: len, opening_no: no, role_name: 'ตั้ง' })
const plan = { groups: [{ key: 'A|F', offcutBars: [{ length_m: 1.2, left_m: 0.1, pieces: [pc(0.6, 'W-01'), pc(0.5, 'W-02')], offcut: { id: 'o1', code: 'OC-0001', length_m: 1.2 } }], bars: [] }] }
const settings = { min_keep_offcut_m: 0.3 }
const view = props => render(<OffcutStockPanel offcuts={offcuts} groupInfo={groupInfo} plan={plan} used settings={settings} projectNames={{ p0: 'บ้านพี่วัฒน์' }}
  canEdit onDiscarded={async () => {}} {...props} />)
const bodyRows = () => [...document.querySelectorAll('tbody tr')]

describe('OffcutStockPanel', () => {
  it('lists only in-stock offcuts of the same profile and finish, with source, length and the plan result', () => {
    view()
    const text = document.body.textContent
    expect(text).toContain('เศษในสต็อก (หน้าตัดที่โครงการนี้ใช้)')
    expect(bodyRows()).toHaveLength(2)
    expect(text).toContain('OC-0001')
    expect(text).toContain('OC-0002')
    for (const c of ['OC-0003', 'OC-0004', 'OC-0005', 'OC-0006']) expect(text).not.toContain(c)
    expect(text).toContain('F7980 กรอบบาน · อบขาว')
    expect(text).toContain('1200')
    expect(text).toContain('บ้านพี่วัฒน์')
    expect(text).toContain('20 ต.ค. 2569')
    expect(bodyRows()[0].textContent).toContain('ใช้ตัด 2 ท่อน')
    expect(bodyRows()[0].textContent).toContain('W-01 600, W-02 500')
    expect(bodyRows()[1].textContent).toContain('ยังอยู่ในสต็อก')
  })
  it('offcuts-first off: result says not used; no edit right: no discard button', () => {
    view({ used: false, canEdit: false })
    expect(bodyRows()[0].textContent).toContain('ไม่ใช้')
    expect(screen.queryByText('ทิ้ง')).toBeNull()
  })
  it('highlights the QR-linked row, or says it is not in this project', () => {
    const scroll = vi.fn()
    const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView')
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    try {
      view({ highlightCode: 'OC-0002' })
      expect(bodyRows()[1].getAttribute('style')).toContain('outline')
      expect(bodyRows()[0].getAttribute('style')).toBeNull()
      expect(scroll).toHaveBeenCalledTimes(1)
      cleanup()
      view({ highlightCode: 'OC-0004' })
      expect(document.body.textContent).toContain('เศษ OC-0004 ไม่อยู่ในหน้าตัดของโครงการนี้')
    } finally {
      if (had) Element.prototype.scrollIntoView = original
      else delete Element.prototype.scrollIntoView
    }
  })
  it('discard asks inline, then discards and reloads', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const onDiscarded = vi.fn(async () => {})
    discardOffcut.mockResolvedValue(undefined)
    view({ onDiscarded })
    fireEvent.click(screen.getAllByText('ทิ้ง')[1])
    expect(document.body.textContent).toContain('ทิ้งเศษ OC-0002 (900 มม.)?')
    fireEvent.click(screen.getByText('ไม่ใช่'))
    expect(document.body.textContent).not.toContain('ทิ้งเศษ OC-0002')
    fireEvent.click(screen.getAllByText('ทิ้ง')[1])
    await act(async () => { fireEvent.click(screen.getByText('ทิ้งเศษ')) })
    expect(discardOffcut).toHaveBeenCalledWith('o2')
    expect(onDiscarded).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.body.textContent).not.toContain('ทิ้งเศษ OC-0002'))
    expect(confirmSpy).not.toHaveBeenCalled()
  })
  it('a failed discard shows the thrown Thai error and still reloads', async () => {
    const onDiscarded = vi.fn(async () => {})
    discardOffcut.mockRejectedValue(new Error('เศษชิ้นนี้ไม่อยู่ในสต็อกแล้ว (ถูกใช้หรือทิ้งไปแล้ว)'))
    view({ onDiscarded })
    fireEvent.click(screen.getAllByText('ทิ้ง')[0])
    await act(async () => { fireEvent.click(screen.getByText('ทิ้งเศษ')) })
    expect(document.body.textContent).toContain('ทิ้ง OC-0001 ไม่สำเร็จ: เศษชิ้นนี้ไม่อยู่ในสต็อกแล้ว (ถูกใช้หรือทิ้งไปแล้ว)')
    expect(onDiscarded).toHaveBeenCalledTimes(1)
  })
  it('a failed reload after a discard is shown, never an unhandled rejection, and the buttons come back', async () => {
    const onDiscarded = vi.fn(async () => { throw new Error('network down') })
    discardOffcut.mockResolvedValue(undefined)
    view({ onDiscarded })
    fireEvent.click(screen.getAllByText('ทิ้ง')[0])
    await act(async () => { fireEvent.click(screen.getByText('ทิ้งเศษ')) })
    expect(onDiscarded).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.body.textContent).toContain('โหลดเศษในสต็อกใหม่ไม่สำเร็จ: network down'))
    expect(screen.getAllByText('ทิ้ง')[0].hasAttribute('disabled')).toBe(false)
  })
})

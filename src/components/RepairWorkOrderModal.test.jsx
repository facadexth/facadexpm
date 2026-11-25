// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

const h = vi.hoisted(() => ({ load: null, release: null, wait: null, download: null }))

vi.mock('../lib/supabase.js', () => ({ supabase: {} }))
vi.mock('../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: { company_name: 'สร้างดี' }, loading: false }) }))
vi.mock('../lib/pdf.js', () => ({ downloadPDF: (...a) => h.download(...a) }))
vi.mock('../lib/repairWorkorderLoad.js', () => ({
  loadWorkOrder: (...a) => h.load(...a),
  waitForSheetImages: (...a) => h.wait(...a),
}))
vi.mock('./RepairWorkOrderSheet.jsx', () => ({ default: ({ wo, id }) => <div id={id} data-testid="sheet">{wo.number}</div> }))

import RepairWorkOrderModal from './RepairWorkOrderModal.jsx'

afterEach(cleanup)

describe('RepairWorkOrderModal', () => {
  it('PDF button waits for the sheet images/QR, then downloads repair-wo-<id> as ใบงานซ่อม-<number>.pdf', async () => {
    h.load = vi.fn(async () => ({ number: 'RP2611-007', mapUrl: 'https://maps.app/x' }))
    h.wait = vi.fn(() => new Promise((r) => { h.release = r }))
    h.download = vi.fn(async () => {})
    render(<RepairWorkOrderModal ticketId="t1" onClose={() => {}} />)
    await screen.findByTestId('sheet')
    expect(screen.getByText('ใบงานซ่อม RP2611-007')).toBeTruthy()
    expect(h.load.mock.calls[0][1]).toBe('t1')
    expect(h.load.mock.calls[0][2]).toEqual({ company_name: 'สร้างดี' })
    const btn = screen.getByText('กำลังเตรียม…')
    expect(btn.disabled).toBe(true)
    await waitFor(() => expect(h.wait).toHaveBeenCalled())
    expect(h.wait.mock.calls[0][0].id).toBe('repair-wo-t1')
    expect(h.wait.mock.calls[0][1]).toEqual({ needQr: true })
    await act(async () => { h.release(true) })
    const ready = await screen.findByText('📄 ดาวน์โหลด PDF')
    expect(ready.disabled).toBe(false)
    fireEvent.click(ready)
    await waitFor(() => expect(h.download).toHaveBeenCalledWith('repair-wo-t1', 'ใบงานซ่อม-RP2611-007.pdf'))
  })

  it('shows the load error', async () => {
    h.load = vi.fn(async () => { throw new Error('โหลดใบงานซ่อมไม่สำเร็จ: boom') })
    h.wait = vi.fn(async () => true)
    render(<RepairWorkOrderModal ticketId="t1" onClose={() => {}} />)
    expect(await screen.findByText('โหลดใบงานซ่อมไม่สำเร็จ: boom')).toBeTruthy()
    expect(screen.getByText('กำลังเตรียม…').disabled).toBe(true)
  })
})

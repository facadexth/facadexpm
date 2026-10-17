// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const rpc = vi.fn()
const update = vi.fn()
const del = vi.fn()
const insert = vi.fn()
const chain = (fn) => ({ eq: (...a) => fn(...a) })
vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    rpc: (...a) => rpc(...a),
    from: () => ({
      update: (p) => ({ eq: (...a) => update(p, ...a) }),
      delete: () => chain(del),
      insert: (p) => insert(p),
    }),
  },
}))

const refetchBoq = vi.fn()
const boq = [
  { id: 'b1', code: '1', description: 'ติดตั้งกระจก', unit: 'ตร.ม.', planned_qty: 50, sort_order: 1 },
  { id: 'b2', code: '2', description: 'อลูมิเนียม', unit: 'ม.', planned_qty: 12.5, sort_order: 2 },
]
const cards = [
  { id: 'c1', site_id: 's1', boq_item_id: 'b1', planned_qty: 20, done_qty: 5 },
  { id: 'c2', site_id: 's1', boq_item_id: 'b1', planned_qty: 10, done_qty: 2.5 },
  { id: 'c3', site_id: 's1', boq_item_id: null, planned_qty: null, done_qty: 0 },
  { id: 'c4', site_id: 's2', boq_item_id: 'b2', planned_qty: 9, done_qty: 9 },
]
vi.mock('../../hooks/useSupabase.js', () => ({
  useBoqItems: () => ({ data: boq, loading: false, error: null, refetch: refetchBoq }),
  usePhaseTasks: () => ({ data: cards, loading: false, error: null, refetch: vi.fn() }),
}))

import BoqTab from './BoqTab.jsx'

afterEach(() => { cleanup(); rpc.mockReset(); update.mockReset(); del.mockReset(); insert.mockReset(); refetchBoq.mockReset() })

describe('BoqTab', () => {
  it('shows contract qty and card sums for this site only, no prices', () => {
    render(<BoqTab siteId="s1" />)
    const r1 = screen.getByTestId('boq-row-b1')
    expect([...r1.querySelectorAll('input')].map((i) => i.value)).toEqual(['1', 'ติดตั้งกระจก', '50', 'ตร.ม.'])
    expect(r1.querySelector('[data-col="in_cards"]').textContent).toBe('30')
    expect(r1.querySelector('[data-col="done"]').textContent).toBe('7.5')
    const r2 = screen.getByTestId('boq-row-b2')
    expect(r2.querySelector('[data-col="in_cards"]').textContent).toBe('0')
    expect(r2.querySelector('[data-col="done"]').textContent).toBe('0')
    expect(document.body.textContent).not.toMatch(/บาท|฿|(?<!เสนอ)ราคา|ต่อหน่วย|มูลค่า/)
  })
  it('highlights in-cards = 0 amber, not others', () => {
    render(<BoqTab siteId="s1" />)
    expect(screen.getByTestId('boq-row-b2').querySelector('[data-col="in_cards"]').getAttribute('data-amber')).toBe('true')
    expect(screen.getByTestId('boq-row-b1').querySelector('[data-col="in_cards"]').getAttribute('data-amber')).toBe('false')
  })
  it('refresh calls the RPC and reports the count', async () => {
    rpc.mockResolvedValue({ data: 3, error: null })
    render(<BoqTab siteId="s1" />)
    fireEvent.click(screen.getByText('ดึงจากใบเสนอราคาอีกครั้ง'))
    await waitFor(() => expect(refetchBoq).toHaveBeenCalled())
    expect(rpc).toHaveBeenCalledWith('boq_refresh_from_quotations', { p_site_id: 's1' })
    expect(screen.getByText(/เพิ่ม 3 บรรทัด/)).toBeTruthy()
  })
  it('shows an RPC error verbatim', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'ไม่มีสิทธิ์ดึง BOQ จากใบเสนอราคา' } })
    render(<BoqTab siteId="s1" />)
    fireEvent.click(screen.getByText('ดึงจากใบเสนอราคาอีกครั้ง'))
    await waitFor(() => expect(screen.getByText('ไม่มีสิทธิ์ดึง BOQ จากใบเสนอราคา')).toBeTruthy())
  })
  it('edits description inline on blur', async () => {
    update.mockResolvedValue({ error: null })
    render(<BoqTab siteId="s1" />)
    const input = screen.getByDisplayValue('ติดตั้งกระจก')
    fireEvent.change(input, { target: { value: 'ติดตั้งกระจกใหม่' } })
    fireEvent.blur(input)
    await waitFor(() => expect(update).toHaveBeenCalledWith({ description: 'ติดตั้งกระจกใหม่' }, 'id', 'b1'))
  })
  it('shows a DB error from a quantity edit verbatim', async () => {
    update.mockResolvedValue({ error: { message: 'จำนวน BOQ น้อยกว่าที่แจกให้การ์ดแล้ว' } })
    render(<BoqTab siteId="s1" />)
    const input = screen.getByDisplayValue('50')
    fireEvent.change(input, { target: { value: '10' } })
    fireEvent.blur(input)
    await waitFor(() => expect(screen.getByText('จำนวน BOQ น้อยกว่าที่แจกให้การ์ดแล้ว')).toBeTruthy())
  })
  it('a rejected save puts the cell back to the stored value', async () => {
    update.mockResolvedValue({ error: { message: 'จำนวน BOQ น้อยกว่าที่แจกให้การ์ดแล้ว' } })
    render(<BoqTab siteId="s1" />)
    const input = screen.getByDisplayValue('50')
    fireEvent.change(input, { target: { value: '10' } })
    fireEvent.blur(input)
    await waitFor(() => expect(input.value).toBe('50'))
    expect(update).toHaveBeenCalledWith({ planned_qty: 10 }, 'id', 'b1')
  })
  it('an invalid quantity is not sent and the cell goes back to the stored value', async () => {
    render(<BoqTab siteId="s1" />)
    const input = screen.getByDisplayValue('50')
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    await waitFor(() => expect(input.value).toBe('50'))
    expect(screen.getByText('จำนวนต้องมากกว่า 0')).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })
  it('deletes only after the built-in confirm (no window.confirm)', async () => {
    const confirmSpy = vi.fn(() => true)
    window.confirm = confirmSpy
    del.mockResolvedValue({ error: null })
    render(<BoqTab siteId="s1" />)
    fireEvent.click(screen.getAllByText('ลบ')[0])
    expect(del).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('ยืนยันลบ'))
    await waitFor(() => expect(del).toHaveBeenCalledWith('id', 'b1'))
    expect(confirmSpy).not.toHaveBeenCalled()
  })
  it('adds a manual row with the next numeric code', async () => {
    insert.mockResolvedValue({ error: null })
    render(<BoqTab siteId="s1" />)
    fireEvent.click(screen.getByText('+ เพิ่มบรรทัด'))
    await waitFor(() => expect(insert).toHaveBeenCalled())
    expect(insert.mock.calls[0][0]).toMatchObject({ site_id: 's1', code: '3', planned_qty: 1, sort_order: 3 })
  })
})

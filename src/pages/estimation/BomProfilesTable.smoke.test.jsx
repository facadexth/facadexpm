// @vitest-environment jsdom
// Section 1 (aluminium by profile + colour): stock-length input errors are shown inline above the table.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import BomProfilesTable from './BomProfilesTable.jsx'

afterEach(cleanup)

const row = (o = {}) => ({
  key: 'p1|f1', profile_id: 'p1', finish_id: 'f1', die_no: '15100', name: 'เฟรมข้าง', finish_name: 'ขาว', openings: ['W-01'],
  cuts: [{ length_m: 1.5, quantity: 2, style: 'square' }], cut_total_m: 3, stock_length_m: 6.4, unplaced: [], count: 1, reusable_m: 3.39, scrap_m: 0, ...o,
})
const view = props => render(<BomProfilesTable profiles={[row()]} overrides={{}} canEdit onSaveStock={async () => {}} {...props} />)

describe('BomProfilesTable errors', () => {
  it('an invalid stock length is shown inline and can be closed, never alert()', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    view()
    const input = screen.getByPlaceholderText('6.40')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(screen.getByRole('alert').textContent).toContain('ความยาวเส้นต้องเป็นตัวเลขมากกว่า 0 และไม่เกิน 20 ม.')
    fireEvent.click(screen.getByLabelText('ปิดข้อความ'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })
  it('a failed save is shown inline with the reason', async () => {
    view({ onSaveStock: async () => { throw new Error('denied') } })
    const input = screen.getByPlaceholderText('6.40')
    fireEvent.change(input, { target: { value: '6' } })
    await act(async () => { fireEvent.blur(input) })
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('บันทึกไม่สำเร็จ')
    expect(box.textContent).toContain('denied')
  })
})

describe('BomProfilesTable stock offcuts', () => {
  const withOffcuts = [
    row({ offcut_codes: ['OC-0002', 'OC-0003'], base_count: 1, count: 0, fromPlan: true }),
    row({ key: 'p2|f1', profile_id: 'p2', name: 'เฟรมบน', offcut_codes: [], base_count: 2, count: 2 }),
  ]
  it('shows the offcut codes per row, the old count struck through and the saving note', () => {
    render(<BomProfilesTable profiles={withOffcuts} overrides={{}} canEdit={false} onSaveStock={async () => {}} />)
    const headers = [...document.querySelectorAll('thead th')].map(th => th.textContent)
    expect(headers).toContain('ใช้เศษในสต็อก')
    expect(headers).toContain('เส้นใหม่')
    expect(headers).not.toContain('จำนวนเส้น')
    const first = document.querySelectorAll('tbody tr')[0]
    expect(first.textContent).toContain('OC-0002')
    expect(first.textContent).toContain('OC-0003')
    expect(first.querySelector('s').textContent).toBe('1')
    expect(document.querySelectorAll('tbody tr')[1].querySelector('s')).toBeNull()
    expect(document.body.textContent).toContain('ใช้เศษ 2 ชิ้น · 1 หน้าตัดนี้ไม่ต้องซื้อเส้นใหม่ · กก. และค่าอลูมิเนียมลดตาม')
  })
  it('no offcuts: the table is as before', () => {
    render(<BomProfilesTable profiles={[row()]} overrides={{}} canEdit={false} onSaveStock={async () => {}} />)
    const headers = [...document.querySelectorAll('thead th')].map(th => th.textContent)
    expect(headers).not.toContain('ใช้เศษในสต็อก')
    expect(headers).toContain('จำนวนเส้น')
    expect(document.body.textContent).not.toContain('ใช้เศษ ')
  })
  it('after issue it says the numbers are the issued plan\'s', () => {
    render(<BomProfilesTable profiles={[row({ fromPlan: true, offcut_codes: [], base_count: 1 })]} overrides={{}} canEdit={false} onSaveStock={async () => {}} issued />)
    expect(document.body.textContent).toContain('หลังยืนยันใบตัดแล้ว ตาราง 1 ใช้ตัวเลขของใบที่ยืนยัน ไม่เปลี่ยนตามสต็อกที่ขยับภายหลัง')
  })
})

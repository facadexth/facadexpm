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

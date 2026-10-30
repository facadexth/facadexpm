// @vitest-environment jsdom
// The custom-length summary: a failed "ใช้ <length>" save is shown inline in the card; never alert().
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(Math.round(n)) }))
const { default: CustomLengthSummary } = await import('./CustomLengthSummary.jsx')

afterEach(cleanup)

const settings = { stock_length_m: 6.4, custom_moq_kg: 1000 }
const group = { key: 'p1|f1', profile_id: 'p1', finish_id: 'f1', name: 'กรอบบน', die_no: 'D-1', finish_name: 'อบขาว', length_m: 6.4, custom: false, no_weight: false, overrideRejected: false, offcutBars: [], bars: [{}, {}], unplaced: [], kg: 12.8, newOffcuts: [] }
const compare = { 'p1|f1': { base: { length_m: 6.4, newBars: 2, kg: 12.8 }, best: { length_m: 6.25, newBars: 2, kg: 12.5 } } }

describe('CustomLengthSummary errors', () => {
  it('a failed save shows an inline error, never alert()', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<CustomLengthSummary plan={{ reason: null, customKg: 0, moqMet: true, groups: [group] }} compare={compare} prices={{ 'p1|f1': 100 }} kgPerM={{ 'p1|f1': 1 }}
      settings={settings} canEdit onUse={async () => { throw new Error('denied') }} onUseAll={async () => {}} />)
    await act(async () => { fireEvent.click(screen.getByText('ใช้ 6.25')) })
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('บันทึกไม่สำเร็จ')
    expect(box.textContent).toContain('denied')
    fireEvent.click(screen.getByLabelText('ปิดข้อความ'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })
})

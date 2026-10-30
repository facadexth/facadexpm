// @vitest-environment jsdom
// The length helper (ตัวช่วยเลือกความยาวเส้น): errors inline; Task 7 adds the 5-row short list.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(Math.round(n)) }))
const { default: CutOptimizerPanel } = await import('./CutOptimizerPanel.jsx')
const { rangeLengths } = await import('../../lib/cutPlan.js')
const { DEFAULT_SETTINGS } = await import('../../lib/estimationSettings.js')

afterEach(cleanup)

const index = {
  providers: { pr: { id: 'pr', price_basis: 'per_kg' } },
  series: { s1: { id: 's1', name: 'ทั่วไป' } },
  profiles: { p1: { id: 'p1', provider_id: 'pr', linear_weight_kg_per_m: 1, default_length_m: 6 } },
  finishes: { f1: { id: 'f1', provider_id: 'pr' } },
  variants: [{ id: 'v6', profile_id: 'p1', finish_id: 'f1', length_m: 6 }, { id: 'v5', profile_id: 'p1', finish_id: 'f1', length_m: 5 }],
  kgPrices: [{ id: 'k', provider_id: 'pr', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 100, effective_from: '2026-01-01' }],
  piecePrices: [],
}
const group = { key: 'p1|f1', profile_id: 'p1', finish_id: 'f1', die_no: null, name: 'เฟรมบน', finish_name: 'ขาว', stock_length_m: 6.4, cuts: [{ length_m: 1.8, quantity: 120, style: 'square' }] }
const view = props => render(<CutOptimizerPanel profiles={[group]} seriesMap={{ 'p1|f1': ['s1'] }} index={index} settings={DEFAULT_SETTINGS} asOf="2026-09-01"
  rangeM={rangeLengths(DEFAULT_SETTINGS)} canEdit onUseLength={async () => {}} {...props} />)

describe('CutOptimizerPanel', () => {
  it('a failed save is shown inline, never alert()', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    view({ onUseLength: async () => { throw new Error('denied') } })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'ใช้' })[0]) })
    const box = screen.getByRole('alert')
    expect(box.textContent).toContain('บันทึกไม่สำเร็จ')
    expect(box.textContent).toContain('denied')
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })
  it('shows the best 5 by kg plus the 6.40 m market bar in use, with the toggle to see all 61', () => {
    view()
    const rows = [...document.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(6)
    expect(rows[0].textContent).toContain('5.45')
    expect(rows[0].textContent).toContain('ดีที่สุด')
    expect(rows[0].textContent).toContain('218.00')
    expect(rows[0].textContent).toContain('−38.00')
    expect(rows[0].cells[1].textContent).toBe('3')
    expect(rows[0].cells[2].textContent).toBe('40')
    expect(rows[5].textContent).toContain('6.40 (เส้นตลาด)')
    expect(rows[5].querySelector('button').textContent).toBe('ใช้อยู่')
    expect(rows[5].querySelector('button').getAttribute('aria-pressed')).toBe('true')
    expect([...document.querySelectorAll('thead th')].map(th => (th.childNodes[0] ? th.childNodes[0].textContent : ''))).toEqual(['ความยาว (ม.)', 'ท่อน/เส้น', 'เส้น', 'กก. ที่ซื้อ', 'เทียบ 6.40', 'ค่าอลูมิเนียม (฿)', ''])
    fireEvent.click(screen.getByText('ดูทั้งหมด 61 ความยาว'))
    expect(document.querySelectorAll('tbody tr')).toHaveLength(61)
    fireEvent.click(screen.getByText('แสดงเฉพาะ 5 ตัวเลือกที่ดีที่สุด'))
    expect(document.querySelectorAll('tbody tr')).toHaveLength(6)
  })
  it('without edit rights the other rows have no ใช้ button', () => {
    view({ canEdit: false })
    expect(screen.queryAllByRole('button', { name: 'ใช้' })).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'ใช้อยู่' })).toBeTruthy()
  })
})

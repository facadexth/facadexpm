// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

let phone = false
vi.mock('../hooks/useIsPhone.js', () => ({ useIsPhone: () => phone }))
vi.mock('../hooks/useUserRole.js', () => ({ useUserRole: () => ({ role: 'ADMIN', isAtLeast: () => true }) }))
vi.mock('recharts', () => ({ PieChart: ({ children }) => <div>{children}</div>, Pie: () => null, Cell: () => null, Tooltip: () => null, ResponsiveContainer: ({ children }) => <div>{children}</div> }))
vi.mock('../hooks/useSupabase.js', () => ({
  useSiteOverview: () => ({ data: { id: 's1', status: 'Active', contract_value: 100, total_income: 1, total_expense: 1, gross_profit: 0, worker_labor_cost: 0, billing_pct: 10, end_date: null, deposit: { total_deposit: 50, total_deducted: 10, remaining_balance: 40 }, retention: { total_retention: 5 } } }),
  useSiteExpensesByCategory: () => ({ data: [] }),
  useQuotations: () => ({ data: [] }),
  useInvoices: () => ({ data: [] }),
}))
import SiteOverviewContent from './SiteOverviewContent.jsx'

describe('SiteOverviewContent phone', () => {
  beforeEach(() => { phone = false })
  it('desktop has no collapsible sections', () => {
    const { container } = render(<SiteOverviewContent siteId="s1" />)
    expect(container.querySelector('details')).toBeNull()
    expect(screen.getByText('💰 มัดจำ')).toBeTruthy()
  })
  it('phone collapses deposit/retention with summaries and orders the key tiles', () => {
    phone = true
    const { container } = render(<SiteOverviewContent siteId="s1" />)
    expect(container.querySelectorAll('details.phone-section').length).toBe(2)
    expect(container.textContent).toContain('คงเหลือ 40')
    const orders = [...container.querySelectorAll('[data-phone="kpis"] > [data-phone-order]')]
    expect(orders.length).toBe(7)
    const first = orders.find(e => e.dataset.phoneOrder === '1')
    expect(first.textContent).toContain('มูลค่าสัญญา')
    expect(orders.find(e => e.dataset.phoneOrder === '2').textContent).toContain('% เบิก')
  })
})

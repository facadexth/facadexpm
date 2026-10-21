// @vitest-environment jsdom
// OWNER / ADMIN dashboard layout smoke test (PM is covered in pmPages.test.jsx).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

let hookRole = 'OWNER'
vi.mock('../hooks/useUserRole.js', () => ({ useUserRole: () => ({ role: hookRole, user: { email: 'o@x.co' }, loading: false }) }))
vi.mock('../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: { id: 't1' }, hasModuleAccess: () => true }) }))
vi.mock('../components/GuideProgressCard.jsx', () => ({ GuideProgressCard: () => null }))
vi.mock('recharts', () => {
  const Box = ({ children }) => <div>{children}</div>
  const Nil = () => null
  return { ResponsiveContainer: Box, BarChart: Box, Bar: Nil, XAxis: Nil, YAxis: Nil, CartesianGrid: Nil, Tooltip: Nil }
})
const empty = { data: [], loading: false, error: null, refetch: () => {} }
vi.mock('../hooks/useSupabase.js', () => ({
  useQuery: () => empty, useSites: () => empty, useExpenses: () => empty, useIncomes: () => empty,
  usePaymentForecast: () => empty, useSitesProgress: () => empty, useSiteRetentionSummary: () => empty,
  useCheques: () => empty, useAppSetting: () => ({ ...empty, data: '3' }),
}))
vi.mock('../hooks/useDashboardData.js', () => ({
  useOwnerDashboard: () => ({ data: { assignments: [], checkins: [], unpaid: [{ amount: 500, due_date: '2000-01-01' }], quotations: [{ status: 'sent' }] } }),
  useAdminDashboard: () => ({ data: { assignments: [], checkins: [], unpaid: [], invoices: [{ id: 'i', total: 41516 }] } }),
  usePmDashboard: () => ({ data: null }),
}))

import Dashboard from './Dashboard.jsx'

beforeEach(() => { window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) })
afterEach(() => { cleanup(); hookRole = 'OWNER'; localStorage.clear() })

describe('OWNER dashboard', () => {
  it('shows the 8 money cards and every new card, without the old table', () => {
    const nav = vi.fn()
    const { container, getByText } = render(<Dashboard navigateTo={nav} pendingCounts={{ po_draft: 1 }} />)
    const text = container.textContent
    for (const t of ['รายรับรวม', 'รายรับไม่มี VAT', 'รายจ่ายรวม', 'กำไรเบื้องต้น', 'Retention ใกล้ครบกำหนด', 'เตรียมเงินจ่ายเช็ค',
      'รายรับ vs รายจ่าย รายเดือน', 'ต้องชำระ 1–3 เดือนข้างหน้า', 'คนงานวันนี้', 'ไซท์ที่ทำงานวันนี้', 'เรื่องรอคุณ',
      'ค่าใช้จ่ายเกินกำหนด', 'เลยกำหนดส่งมอบ', 'ใบเสนอราคาเดือนนี้']) expect(text).toContain(t)
    expect(text).not.toContain('กดหัวตารางเพื่อเรียง')
    expect(text).not.toContain('ยอดที่ต้องชำระ (รายเดือน)')
    fireEvent.click(getByText(/PO|ใบสั่งซื้อฉบับร่าง/))
    expect(nav).toHaveBeenCalledWith('purchase_orders', { pending: 'po_draft' })
  })

  it('customizer groups cards and hiding one persists under the same key', () => {
    const { getByText, getByLabelText, container } = render(<Dashboard navigateTo={() => {}} />)
    fireEvent.click(getByText('⚙️ ปรับแต่งการ์ด'))
    expect(container.ownerDocument.body.textContent).toContain('เงิน (เดิม)')
    expect(container.ownerDocument.body.textContent).toContain('วันนี้ / หน้างาน (ใหม่)')
    fireEvent.click(getByLabelText('ใบเสนอราคาเดือนนี้'))
    fireEvent.click(getByText('✅ บันทึก'))
    const saved = JSON.parse(localStorage.getItem('dashboard-kpi-prefs:o@x.co'))
    expect(saved.hidden).toEqual(['quotations_month'])
    expect(container.textContent).not.toContain('ใบเสนอราคาเดือนนี้')
  })
})

describe('ADMIN dashboard', () => {
  it('shows approvals, payables, receivables and check-ins, no sales/profit', () => {
    hookRole = 'ADMIN'
    const { container } = render(<Dashboard navigateTo={() => {}} />)
    const text = container.textContent
    for (const t of ['เรื่องรออนุมัติ', 'ต้องจ่าย', 'ต้องรับ', '41,516', 'คนงานวันนี้']) expect(text).toContain(t)
    for (const t of ['รายรับรวม', 'กำไร', 'รายรับ vs รายจ่าย']) expect(text).not.toContain(t)
  })
})

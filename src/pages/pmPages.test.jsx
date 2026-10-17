// @vitest-environment jsdom
// Smoke test: a PM loads Sites, SiteDetail and Dashboard with PM-shaped data (no money
// fields) and sees no money anywhere, on desktop and phone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { setCurrentRole, navGroupLabel } from '../lib/roles.js'
import { saveDraft, clearDraft } from '../hooks/useDraftForm.js'

const PM_SITE = {
  id: 's1', site_number: 'S-001', name: 'Tower A', short_name: 'TA', status: 'Ongoing',
  start_date: '2026-09-01', end_date: '2026-12-31', client_id: 'c1', client_name: 'Client Co',
  location: 'Bangkok', map_url: null, lat: 13.7, lng: 100.5, distance_km: 12, travel_minutes: 30,
  is_default: false, notes: 'note', created_at: '2026-09-01T00:00:00Z',
}

let phone = false
let sitesData = [PM_SITE]
let poData = []
// The page's own useUserRole instance; null = not resolved yet (the global role may already be PM).
let hookRole = 'PM'
let stockData = []
let incomesData = []
const rpcCalls = []
const fromCalls = []
// Per-test rows the mocked supabase returns, by table / RPC name (filters are ignored).
let tableRows = {}
let rpcRows = {}
vi.mock('../hooks/useIsPhone.js', () => ({ useIsPhone: () => phone, PHONE_QUERY: '(max-width: 900px)' }))
vi.mock('../hooks/useUserRole.js', () => ({
  useUserRole: () => ({ role: hookRole, user: { email: 'pm@x.co' }, loading: false, isAtLeast: r => ({ OWNER: 3, ADMIN: 2, PM: 1.5, WORKER: 1 })[r] <= 1.5 }),
}))
vi.mock('../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: { id: 't1' }, hasModuleAccess: () => true }) }))
vi.mock('recharts', () => {
  const Box = ({ children }) => <div>{children}</div>
  const Nil = () => null
  return { ResponsiveContainer: Box, PieChart: Box, BarChart: Box, LineChart: Box, ComposedChart: Box, AreaChart: Box, Pie: Nil, Cell: Nil, Tooltip: Nil, Bar: Nil, Line: Nil, Area: Nil, XAxis: Nil, YAxis: Nil, CartesianGrid: Nil, Legend: Nil, ReferenceLine: Nil }
})
vi.mock('../lib/supabase.js', async (orig) => {
  const actual = await orig()
  const chain = (rows = []) => {
    const q = new Proxy({}, {
      get: (_, k) => k === 'then' ? (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej)
        : k === 'single' || k === 'maybeSingle' ? () => Promise.resolve({ data: null, error: null })
        : () => q,
    })
    return q
  }
  return {
    ...actual,
    supabase: {
      from: t => { fromCalls.push(t); return chain(tableRows[t]) },
      rpc: (n, a) => { rpcCalls.push([n, a]); return chain(rpcRows[n]) },
      auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      channel: () => ({ on() { return this }, subscribe() { return this } }),
      removeChannel: () => {},
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
      storage: { from: () => ({ list: () => Promise.resolve({ data: [], error: null }), createSignedUrls: () => Promise.resolve({ data: [], error: null }) }) },
    },
  }
})
const empty = { data: [], loading: false, error: null, refetch: () => {} }
vi.mock('../hooks/useSupabase.js', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    useQuery: () => empty,
    useSites: () => ({ ...empty, data: sitesData }),
    useSite: () => ({ ...empty, data: PM_SITE }),
    useSiteOverview: () => ({ ...empty, data: { ...PM_SITE, deposit: null, retention: null } }),
    useSitesProgress: () => empty,
    useSiteExpensesByCategory: () => empty,
    useQuotations: () => empty,
    useInvoices: () => empty,
    useLaborCost: () => empty,
    useClients: () => empty,
    useSeatStatus: () => ({ ...empty, data: null }),
    useCategories: () => empty,
    useSiteCostEstimates: () => empty,
    usePhaseTasks: () => empty,
    useExpenses: () => empty,
    useIncomes: () => ({ ...empty, data: incomesData }),
    usePaymentForecast: () => empty,
    useSiteRetentionSummary: () => empty,
    useCheques: () => empty,
    useAppSetting: () => ({ ...empty, data: '3' }),
    usePurchaseOrders: () => ({ ...empty, data: poData }),
    usePmStockOnHand: () => ({ ...empty, data: stockData }),
  }
})

import Sites, { pmSitePatch } from './Sites.jsx'
import SiteDetail from './SiteDetail.jsx'
import Dashboard from './Dashboard.jsx'
import Assign from './Assign.jsx'
import HR from './HR.jsx'
import DailyReport from './sites/DailyReport.jsx'
import PhaseKanbanBoard from './sites/PhaseKanbanBoard.jsx'
import PurchaseOrders from './PurchaseOrders.jsx'
import Inventory from './Inventory.jsx'
import GanttView from './sites/GanttView.jsx'

const MONEY = /฿|บาท|มูลค่าสัญญา|รายรับ|รายจ่าย/

beforeEach(() => {
  setCurrentRole('PM')
  rpcCalls.length = 0
  fromCalls.length = 0
  window.matchMedia = q => ({ matches: phone && q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
})
afterEach(() => { cleanup(); setCurrentRole(null); phone = false; sitesData = [PM_SITE]; poData = []; stockData = []; incomesData = []; hookRole = 'PM'; clearDraft('purchase-order-form-open'); tableRows = {}; rpcRows = {} })

describe.each([false, true])('PM pages (phone=%s)', isPhone => {
  beforeEach(() => { phone = isPhone })

  it('Sites shows the site without money and no add button', () => {
    const { container } = render(<Sites navigateTo={() => {}} openSiteOverview={() => {}} navState={{}} />)
    expect(container.textContent).toContain('Tower A')
    expect(container.textContent).not.toMatch(MONEY)
    expect(container.textContent).not.toContain('เพิ่มไซท์')
    expect(container.textContent).not.toContain('% เบิก')
  })

  it('SiteDetail overview and Gantt tab show no money and no S-curve', () => {
    const { container, getByText } = render(<SiteDetail navState={{ siteId: 's1', siteName: 'Tower A' }} navigateTo={() => {}} />)
    expect(container.textContent).toContain('Tower A')
    expect(container.textContent).toContain('Ongoing')
    expect(container.textContent).not.toMatch(MONEY)
    expect(container.textContent).not.toContain('% เบิก')
    fireEvent.click(getByText('📅 Gantt'))
    expect(container.textContent).not.toMatch(MONEY)
    expect(container.textContent).not.toContain('S-curve')
  })

  it('Dashboard lists the ongoing site without billing %', () => {
    const { container } = render(<Dashboard navigateTo={() => {}} openSiteOverview={() => {}} />)
    expect(container.textContent).toContain('Tower A')
    expect(container.textContent).not.toMatch(MONEY)
    expect(container.textContent).not.toContain('ความคืบหน้างาน')
  })
})

describe('PM site form', () => {
  it('hides money fields and saves only changed allowed keys via pm_update_site', async () => {
    const { container } = render(<Sites navigateTo={() => {}} openSiteOverview={() => {}} navState={{}} />)
    fireEvent.click(container.querySelector('.btn-edit'))
    const form = container.ownerDocument.querySelector('form')
    expect(form.textContent).not.toMatch(MONEY)
    expect(form.textContent).not.toContain('VAT')
    expect(form.textContent).not.toContain('Retention')
    expect(form.textContent).not.toContain('ต้นทุน')
    const loc = [...form.querySelectorAll('input')].find(i => i.value === 'Bangkok')
    fireEvent.change(loc, { target: { value: 'Chiang Mai' } })
    fireEvent.submit(form)
    await new Promise(r => setTimeout(r, 0))
    expect(rpcCalls).toContainEqual(['pm_update_site', { p_site_id: 's1', p_patch: { location: 'Chiang Mai' } }])
    expect(fromCalls).not.toContain('sites')
  })

  it('PM status select offers no Completed option (kept disabled only for an already-Completed site)', () => {
    const { container, unmount } = render(<Sites navigateTo={() => {}} openSiteOverview={() => {}} navState={{}} />)
    fireEvent.click(container.querySelector('.btn-edit'))
    const select = () => [...document.querySelectorAll('form select')].find(el => [...el.options].some(o => o.value === 'Ongoing'))
    expect([...select().options].map(o => o.value)).toEqual(['Ongoing', 'On Hold', 'Cancelled'])
    unmount()
    sitesData = [{ ...PM_SITE, status: 'Completed' }]
    const r2 = render(<Sites navigateTo={() => {}} openSiteOverview={() => {}} navState={{}} />)
    fireEvent.change(r2.container.querySelector('select'), { target: { value: 'All' } })
    fireEvent.click(r2.container.querySelector('.btn-edit'))
    const opts = [...select().options]
    expect(select().value).toBe('Completed')
    expect(opts.find(o => o.value === 'Completed').disabled).toBe(true)
    expect(opts.filter(o => !o.disabled).map(o => o.value)).toEqual(['Ongoing', 'On Hold', 'Cancelled'])
  })

  it('pmSitePatch sends nothing for an untouched site with empty fields', () => {
    const site = { ...PM_SITE, lat: null, lng: null, distance_km: null, travel_minutes: null, map_url: null, notes: null, short_name: null, start_date: null }
    expect(pmSitePatch(site, { ...site })).toEqual({})
    expect(pmSitePatch(site, { ...site, lat: '14.1', status: 'On Hold' })).toEqual({ lat: 14.1, status: 'On Hold' })
  })
})

// PM-shaped worker row from pm_workers: no salary / daily rate / SSO / contribution.
const PM_WORKER = {
  id: 'w1', name: 'Somchai Jaidee', nickname: 'Chai', position: 'ช่างอลูมิเนียม', status: 'active',
  email: 'w1@x.co', show_in_assign: true, line_user_id: null, annual_leave_days: 6, annual_sick_leave_days: 30,
}
const TODAY = new Date().toISOString().slice(0, 10)
const SALARY = /เงินเดือน|ค่าแรง|บ\/วัน|SSO|ประกันสังคม|เงินสมทบ/
const flush = () => new Promise(r => setTimeout(r, 0))

describe.each([false, true])('PM assign / HR / site crew (phone=%s)', isPhone => {
  beforeEach(() => {
    phone = isPhone
    rpcRows = { pm_workers: [PM_WORKER], pm_sites: [PM_SITE] }
    // Embeds of workers(...) come back null for PM: the base table is not readable.
    tableRows = {
      worker_assignments: [{ id: 'a1', worker_id: 'w1', site_id: 's1', date: TODAY, shift: 'morning', type: 'site', is_team_leader: true, workers: null }],
      leave_requests: [{ id: 'l1', worker_id: 'w1', status: 'pending', leave_type: 'leave_personal', date_from: TODAY, date_to: TODAY, shift: 'full_day', reason: 'ธุระ', requested_at: TODAY, workers: null }],
      line_issue_reports: [{ id: 'i1', worker_id: 'w1', message: 'กระจกร้าว', status: 'open', created_at: `${TODAY}T03:00:00Z`, workers: null }],
      site_phases: [{ id: 'p1', site_id: 's1', name: 'ติดตั้งกระจก', sort_order: 1, is_issue_phase: false }],
    }
  })

  it('Assign shows the crew and the team manager, with no cost text', async () => {
    const { container, findAllByText, getByText } = render(<Assign navState={{}} navigateTo={() => {}} openSiteOverview={() => {}} />)
    expect((await findAllByText('Chai')).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('จัดการทีม')
    expect(container.textContent).not.toMatch(MONEY)
    expect(container.textContent).not.toMatch(SALARY)
    expect(container.textContent).not.toContain('ค่าเดินทาง')
    fireEvent.click(getByText('วัน'))
    expect((await findAllByText('Chai')).length).toBeGreaterThan(0)
    expect(container.textContent).not.toMatch(MONEY)
    expect(container.textContent).not.toContain('รวมวันนี้')
    expect(container.textContent).not.toMatch(/แรง \d/)
  })

  it('HR lists all workers from pm_workers with no salary and no add/edit', async () => {
    const { container, findByText } = render(<HR navState={{}} />)
    await findByText('Somchai Jaidee')
    expect(container.textContent).not.toMatch(MONEY)
    expect(container.textContent).not.toMatch(SALARY)
    expect(container.textContent).not.toContain('เพิ่มพนักงาน')
    expect(container.querySelector('.btn-edit')).toBeNull()
    expect(container.textContent).not.toContain('เช็คอิน-เช็คเอาท์')
    expect(container.textContent).not.toContain('ประวัติการแก้ไข')
  })

  it('HR requests tab shows the leave with the worker name and an approve button', async () => {
    const { container, findByText, getByText } = render(<HR navState={{}} />)
    fireEvent.click(await findByText(/คำขอลา/))
    await findByText('อนุมัติ')
    expect(getByText('ปฏิเสธ')).toBeTruthy()
    expect(container.textContent).toContain('Chai')
  })

  it('Daily report shows crew and issue reporter names from pm_workers', async () => {
    const { container, findAllByText } = render(<DailyReport site={PM_SITE} />)
    expect((await findAllByText(/Chai/)).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('Chai')
    expect(container.textContent).not.toContain('ไม่ทราบชื่อ')
  })

  it('Kanban shows today\'s team leader name from pm_workers', async () => {
    const { findByText } = render(<PhaseKanbanBoard site={PM_SITE} canEdit onTasksChanged={() => {}} />)
    expect(await findByText('Chai')).toBeTruthy()
  })
})

describe('PM leave approval', () => {
  beforeEach(() => {
    rpcRows = { pm_workers: [PM_WORKER], pm_sites: [PM_SITE] }
    tableRows = { leave_requests: [{ id: 'l1', worker_id: 'w1', status: 'pending', leave_type: 'leave_personal', date_from: TODAY, date_to: TODAY, shift: 'morning', reason: null, requested_at: TODAY, workers: null }] }
  })

  it('approve writes the leave day and updates the request', async () => {
    const { findByText } = render(<HR navState={{}} />)
    fireEvent.click(await findByText(/คำขอลา/))
    fireEvent.click(await findByText('อนุมัติ'))
    await flush(); await flush()
    expect(fromCalls).toContain('worker_assignments')
    expect(fromCalls.filter(t => t === 'leave_requests').length).toBeGreaterThan(1)
  })
})

// PM-shaped PO row from pm_purchase_orders: no items, totals, VAT, deposit or expense.
const PM_PO = {
  id: 'po1', po_number: 'PO-2026-001', site_id: 's1', supplier_id: 'sup1', supplier_name: 'Glass Supply',
  suppliers: { name: 'Glass Supply' }, date: TODAY, status: 'ordered', notes: 'ส่งหน้างาน', received_date: null,
  ordered_by: 'Somchai', created_at: `${TODAY}T01:00:00Z`,
}
const PM_STOCK = [
  { inventory_item_id: 'it1', code: 'GL-01', name: 'กระจกใส 6 มม.', base_unit: 'แผ่น', site_id: 's1', quantity_on_hand: 12, updated_at: `${TODAY}T01:00:00Z` },
  { inventory_item_id: 'it2', code: 'AL-02', name: 'อลูมิเนียม 2 นิ้ว', base_unit: 'เส้น', site_id: 's1', quantity_on_hand: 40, updated_at: `${TODAY}T01:00:00Z` },
]
const PRICE = /฿|บาท|ราคา|มูลค่า|ต้นทุน/

describe.each([false, true])('PM purchase orders / inventory (phone=%s)', isPhone => {
  beforeEach(() => {
    phone = isPhone
    poData = [PM_PO]
    stockData = PM_STOCK
    rpcRows = { pm_purchase_order_items: [{ id: 'i1', po_id: 'po1', description: 'กระจกเทมเปอร์ 10 มม.', quantity: 8, unit: 'แผ่น', sort_order: 0, inventory_item_id: null }] }
  })

  it('PurchaseOrders lists the PO with its site name, read-only and without prices', () => {
    const { container } = render(<PurchaseOrders navigateTo={() => {}} navState={{}} openSiteOverview={() => {}} />)
    expect(container.textContent).toContain('PO-2026-001')
    expect(container.textContent).toContain('Tower A')
    expect(container.textContent).toContain('Glass Supply')
    expect(container.textContent).not.toMatch(PRICE)
    expect(container.textContent).not.toContain('ยอดรวม')
    expect(container.textContent).not.toContain('เพิ่มใบสั่งซื้อ')
    expect(container.textContent).not.toContain('⋮')
  })

  it('PO detail shows items from pm_purchase_order_items, no totals, VAT or preview', async () => {
    const { container, getByLabelText, findByText } = render(<PurchaseOrders navigateTo={() => {}} navState={{}} openSiteOverview={() => {}} />)
    fireEvent.click(getByLabelText('📄 ดูใบสั่งซื้อ / เอกสาร'))
    await findByText('กระจกเทมเปอร์ 10 มม.')
    expect(rpcCalls).toContainEqual(['pm_purchase_order_items', { p_po_id: 'po1' }])
    const text = container.ownerDocument.body.textContent
    expect(text).toContain('ส่งหน้างาน')
    expect(text).not.toMatch(PRICE)
    expect(text).not.toContain('VAT')
    expect(text).not.toContain('มัดจำ')
    expect(text).not.toContain('Preview')
    expect(fromCalls).not.toContain('purchase_order_items')
  })

  it('Inventory lists on-hand stock per site from pm_inventory_on_hand, read-only and without cost', () => {
    const { container } = render(<Inventory />)
    expect(container.textContent).toContain('กระจกใส 6 มม.')
    expect(container.textContent).toContain('GL-01')
    expect(container.textContent).toContain('Tower A')
    expect(container.textContent).toMatch(/12(\.00)?\s*แผ่น/)
    expect(container.textContent).not.toMatch(PRICE)
    expect(container.textContent).not.toContain('เพิ่มสินค้าคงคลัง')
    expect(container.textContent).not.toContain('ตัดสต็อกจากใบแจ้งหนี้')
    expect(container.textContent).not.toContain('รายงานภาษี')
    expect(container.querySelector('.btn-edit')).toBeNull()
  })
})

describe('PM never reopens the PO add form', () => {
  it('a stale add-form flag does not open PurchaseOrderForm, even before the page\'s role resolves', () => {
    poData = [PM_PO]
    saveDraft('purchase-order-form-open', true)
    hookRole = null   // this instance has not resolved yet; App already set the global role to PM
    const r1 = render(<PurchaseOrders navigateTo={() => {}} navState={{}} openSiteOverview={() => {}} />)
    expect(r1.container.textContent).not.toContain('เพิ่มใบสั่งซื้อ')
    expect(r1.container.textContent).not.toContain('รายการสินค้า ★')
    r1.unmount()
    hookRole = 'PM'
    const r2 = render(<PurchaseOrders navigateTo={() => {}} navState={{}} openSiteOverview={() => {}} />)
    expect(r2.container.textContent).toContain('PO-2026-001')
    expect(r2.container.textContent).not.toContain('รายการสินค้า ★')
  })
})

describe('PM final-review fixes', () => {
  it('Gantt never syncs sites.start_date/end_date for PM; OWNER/ADMIN still do', async () => {
    // an income dated before the site start widens the timeline, so the sync would fire
    const site = { ...PM_SITE }
    incomesData = [{ id: 'inc1', site_id: 's1', date: '2026-06-01', amount: 1 }]
    const r1 = render(<GanttView sites={[site]} canEdit navigateTo={() => {}} onManagePhases={() => {}} onSelectSite={() => {}} selectedSiteId="s1" onPhasesChanged={() => {}} onOpenKanban={() => {}} />)
    await flush()
    expect(fromCalls).not.toContain('sites')
    r1.unmount()
    hookRole = 'ADMIN'
    render(<GanttView sites={[site]} canEdit navigateTo={() => {}} onManagePhases={() => {}} onSelectSite={() => {}} selectedSiteId="s1" onPhasesChanged={() => {}} onOpenKanban={() => {}} />)
    await flush()
    expect(fromCalls).toContain('sites')
  })

  it('nav: PM sees the purchase-orders group as จัดซื้อ, every other role keeps รายจ่าย', () => {
    const group = { label: '💸 รายจ่าย', pmLabel: '🧾 จัดซื้อ', children: [] }
    expect(navGroupLabel('PM', group)).toBe('🧾 จัดซื้อ')
    for (const r of ['OWNER', 'ADMIN', 'WORKER', null]) expect(navGroupLabel(r, group)).toBe('💸 รายจ่าย')
    expect(navGroupLabel('PM', { label: '🏗️ ไซท์งาน', children: [] })).toBe('🏗️ ไซท์งาน')
  })

  it('PO list: PM clicking a site name opens site_detail, not the money-only overview modal', () => {
    poData = [PM_PO]
    const navigateTo = vi.fn(); const openSiteOverview = vi.fn()
    const { getByText } = render(<PurchaseOrders navigateTo={navigateTo} navState={{}} openSiteOverview={openSiteOverview} />)
    fireEvent.click(getByText('Tower A'))
    expect(openSiteOverview).not.toHaveBeenCalled()
    expect(navigateTo).toHaveBeenCalledWith('site_detail', { siteId: 's1', siteName: 'Tower A' })
  })

  it('Sites table: PM has no กิจกรรมล่าสุด column and sorts by site code by default', () => {
    sitesData = [{ ...PM_SITE, id: 's1', site_number: 'S-001', name: 'Tower A' }, { ...PM_SITE, id: 's2', site_number: 'S-002', name: 'Tower B' }]
    const { container, unmount } = render(<Sites navigateTo={() => {}} openSiteOverview={() => {}} navState={{}} />)
    expect(container.querySelector('thead').textContent).not.toContain('กิจกรรมล่าสุด')
    expect(container.querySelector('thead').textContent).toContain('รหัส ↓')
    expect([...container.querySelectorAll('tbody tr')].map(tr => tr.cells[0].textContent)).toEqual(['S-002', 'S-001'])
    unmount()
    hookRole = 'ADMIN'
    const r2 = render(<Sites navigateTo={() => {}} openSiteOverview={() => {}} navState={{}} />)
    expect(r2.container.querySelector('thead').textContent).toContain('กิจกรรมล่าสุด ↓')
  })
})

// @vitest-environment jsdom
// Smoke test: a PM loads Sites, SiteDetail and Dashboard with PM-shaped data (no money
// fields) and sees no money anywhere, on desktop and phone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { setCurrentRole } from '../lib/roles.js'

const PM_SITE = {
  id: 's1', site_number: 'S-001', name: 'Tower A', short_name: 'TA', status: 'Ongoing',
  start_date: '2026-09-01', end_date: '2026-12-31', client_id: 'c1', client_name: 'Client Co',
  location: 'Bangkok', map_url: null, lat: 13.7, lng: 100.5, distance_km: 12, travel_minutes: 30,
  is_default: false, notes: 'note', created_at: '2026-09-01T00:00:00Z',
}

let phone = false
const rpcCalls = []
const fromCalls = []
vi.mock('../hooks/useIsPhone.js', () => ({ useIsPhone: () => phone, PHONE_QUERY: '(max-width: 900px)' }))
vi.mock('../hooks/useUserRole.js', () => ({
  useUserRole: () => ({ role: 'PM', user: { email: 'pm@x.co' }, loading: false, isAtLeast: r => ({ OWNER: 3, ADMIN: 2, PM: 1.5, WORKER: 1 })[r] <= 1.5 }),
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
      from: t => { fromCalls.push(t); return chain() },
      rpc: (n, a) => { rpcCalls.push([n, a]); return chain() },
      auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      channel: () => ({ on() { return this }, subscribe() { return this } }),
      removeChannel: () => {},
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
      storage: { from: () => ({ list: () => Promise.resolve({ data: [], error: null }) }) },
    },
  }
})
const empty = { data: [], loading: false, error: null, refetch: () => {} }
vi.mock('../hooks/useSupabase.js', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    useQuery: () => empty,
    useSites: () => ({ ...empty, data: [PM_SITE] }),
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
    useIncomes: () => empty,
    usePaymentForecast: () => empty,
    useSiteRetentionSummary: () => empty,
    useCheques: () => empty,
    useAppSetting: () => ({ ...empty, data: '3' }),
  }
})

import Sites, { pmSitePatch } from './Sites.jsx'
import SiteDetail from './SiteDetail.jsx'
import Dashboard from './Dashboard.jsx'

const MONEY = /฿|บาท|มูลค่าสัญญา|รายรับ|รายจ่าย/

beforeEach(() => {
  setCurrentRole('PM')
  rpcCalls.length = 0
  fromCalls.length = 0
  window.matchMedia = q => ({ matches: phone && q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
})
afterEach(() => { cleanup(); setCurrentRole(null); phone = false })

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

  it('pmSitePatch sends nothing for an untouched site with empty fields', () => {
    const site = { ...PM_SITE, lat: null, lng: null, distance_km: null, travel_minutes: null, map_url: null, notes: null, short_name: null, start_date: null }
    expect(pmSitePatch(site, { ...site })).toEqual({})
    expect(pmSitePatch(site, { ...site, lat: '14.1', status: 'On Hold' })).toEqual({ lat: 14.1, status: 'On Hold' })
  })
})

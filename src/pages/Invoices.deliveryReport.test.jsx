// @vitest-environment jsdom
// Delivery report entry point on the invoices list: ⋮ action, signed badge, one status query, seen marking.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const INVOICES = [
  { id: 'i1', invoice_number: 'IN1', date: '2026-10-01', site_id: 's1', status: 'unpaid', invoice_items: [], sites: { name: 'A' } },
  { id: 'i2', invoice_number: 'IN2', date: '2026-10-02', site_id: null, status: 'unpaid', invoice_items: [] },
]
let statuses = {}
const fetchStatuses = vi.fn(async () => statuses)
const seenMany = vi.fn(async () => {})

vi.mock('../hooks/useSupabase.js', () => {
  const none = () => ({ data: null, loading: false, error: null, refetch: () => {} })
  return {
    useInvoices: () => ({ data: INVOICES, error: null, refetch: () => {} }),
    useQuotations: none, useSites: none, useReceipts: none, useInvoicePhotos: none,
    useDocumentReceipt: none, useDocumentSigner: none, useBankAccounts: none, useSiteDepositBalance: none,
    useQuotationDepositTaxOffset: () => ({ data: 0 }), getQuotationDepositTaxOffset: async () => 0,
    logDocumentPrint: async () => {}, useInvoiceDepositChoiceReady: () => false,
    useSiteReservedDeposit: () => ({ data: { total: 0, invoices: [] } }),
    useQuotationItemUnits: none,
  }
})
vi.mock('../hooks/useDeliveryReport.js', () => ({
  fetchDeliveryReportStatuses: (...a) => fetchStatuses(...a),
  markSignedSeenMany: (...a) => seenMany(...a),
}))
vi.mock('./invoices/delivery/DeliveryReportEditor.jsx', () => ({ default: () => <div>EDITOR</div> }))
vi.mock('./invoices/delivery/SignChooser.jsx', () => ({ DeliveryReportWithSigning: () => <div>DOCUMENT</div> }))
vi.mock('../hooks/useProgressBillingData.js', () => ({ useProgressBillingData: () => ({ data: null }) }))
vi.mock('../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: { id: 't1' }, hasModuleAccess: () => false }) }))
vi.mock('../hooks/useUserRole.js', () => ({ useUserRole: () => ({ isAtLeast: () => true, role: 'OWNER' }) }))
vi.mock('../hooks/useIsPhone.js', () => ({ useIsPhone: () => false }))
vi.mock('../lib/supabase.js', () => ({ supabase: { from: () => ({}) }, fmt: n => String(n), fmtDate: d => String(d) }))

import Invoices from './Invoices.jsx'

afterEach(() => { cleanup(); statuses = {}; fetchStatuses.mockClear(); seenMany.mockClear() })

// rows sort by date desc: row 0 = IN2 (no site), row 1 = IN1
const openMenu = n => fireEvent.click(screen.getAllByText('⋮')[n])

describe('invoices delivery report', () => {
  it('invoice row shows รายงานส่งงาน action (only with a site) and opens the editor when none exists', async () => {
    render(<Invoices openSiteOverview={() => {}} />)
    await waitFor(() => expect(fetchStatuses).toHaveBeenCalledTimes(1))
    expect(fetchStatuses.mock.calls[0][0]).toEqual(['i1'])
    openMenu(0)
    expect(screen.queryByText('📋 รายงานส่งงาน')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    cleanup()
    render(<Invoices openSiteOverview={() => {}} />)
    openMenu(1)
    fireEvent.click(screen.getByText('📋 รายงานส่งงาน'))
    expect(screen.getByText('EDITOR')).toBeTruthy()
  })

  it('signed badge shows date, opens the document and marks unseen as seen', async () => {
    statuses = { i1: { id: 'r1', invoice_id: 'i1', status: 'signed', signed_at: '2026-10-20T03:00:00Z', signed_seen_at: null } }
    render(<Invoices openSiteOverview={() => {}} />)
    const badge = await screen.findByTestId('dr-signed-badge')
    expect(badge.textContent).toMatch(/ลูกค้าเซ็นรับงานแล้ว 20 ต\.ค\. 2569/)
    await waitFor(() => expect(seenMany).toHaveBeenCalledWith(['r1']))
    openMenu(1)
    fireEvent.click(screen.getByText('📋 รายงานส่งงาน'))
    expect(screen.getByText('DOCUMENT')).toBeTruthy()
  })
})

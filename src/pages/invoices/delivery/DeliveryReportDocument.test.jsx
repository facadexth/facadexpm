// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

let hookData = null
vi.mock('../../../hooks/useDeliveryReport.js', () => ({
  useDeliveryReport: () => ({ data: hookData, loading: false, error: null, refetch: () => {} }),
}))
vi.mock('../../../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: { id: 't1', company_name: 'ACME' } }) }))
vi.mock('../../../hooks/useBackToClose.js', () => ({ useBackToClose: () => {} }))
vi.mock('../../../lib/pdf.js', () => ({ downloadPDF: vi.fn() }))
vi.mock('../../../lib/supabase.js', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    // 'gone.jpg' has no signed URL (file removed from storage)
    storage: { from: () => ({ createSignedUrls: async paths => ({ data: paths.map(p => ({ signedUrl: p === 'gone.jpg' ? null : 'u:' + p })) }) }) },
  },
  fmt: n => String(n ?? 0),
}))

import DeliveryReportDocumentModal from './DeliveryReportDocument.jsx'

const report = { id: 'r1', report_number: 'DR2610-001', date: '2026-10-23', status: 'issued' }
function makeData(over = {}) {
  return {
    invoice: { id: 'inv1', invoice_number: 'IN2610-004' },
    reports: [report], current: report, report, replacedBy: null, prevTaskIds: [], site: { name: 'SOAP OPERA' }, rows: [],
    totals: { contract: 100, prev: 20, this: 30, remaining: 50 },
    cards: [], tasks: [], phases: [], photosByTask: {}, plans: [], marksByPlan: {},
    ...over,
  }
}
afterEach(() => { cleanup(); hookData = null })

describe('DeliveryReportDocument', () => {
  it('header shows DR and invoice number', () => {
    hookData = makeData()
    render(<DeliveryReportDocumentModal invoiceId="inv1" reportId="r1" onClose={() => {}} />)
    expect(screen.getAllByText(/DR2610-001/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/อ้างอิงใบแจ้งหนี้ IN2610-004/).length).toBeGreaterThan(0)
  })

  it('replaced report shows banner and site name', () => {
    hookData = makeData({ replacedBy: { id: 'r2', report_number: 'DR2610-002' } })
    render(<DeliveryReportDocumentModal invoiceId="inv1" reportId="r1" onClose={() => {}} />)
    expect(screen.getAllByText(/ฉบับนี้ถูกแทนด้วย DR2610-002/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('SOAP OPERA').length).toBeGreaterThan(0)
  })

  it('long description is clipped; signature moves to own page after a full card page', () => {
    hookData = makeData({
      rows: [{ key: 'k', description: 'ก'.repeat(200), value: 0, prev: 0, this: 0, remaining: 0 }],
      cards: [{ id: 'c1', task_id: null, card_title: 'A', photo_ids: [], caption: 'x'.repeat(150) }],
    })
    render(<DeliveryReportDocumentModal invoiceId="inv1" reportId="r1" onClose={() => {}} />)
    expect(screen.getByTitle('ก'.repeat(200)).textContent.length).toBe(90)
    expect(screen.getAllByText(/หน้า \d+ \/ 3/).length).toBe(3)
  })

  it('bar widths match totals', () => {
    hookData = makeData()
    render(<DeliveryReportDocumentModal invoiceId="inv1" reportId="r1" onClose={() => {}} />)
    const segs = [...screen.getByTestId('dr-bar').children].map(d => d.style.width)
    expect(segs).toEqual(['20%', '30%', '50%'])
  })

  it('deleted card prints (การ์ดถูกลบ) and no img', () => {
    hookData = makeData({ cards: [{ id: 'c1', task_id: null, card_title: 'งานหุ้ม', photo_ids: ['p1'] }] })
    const { container } = render(<DeliveryReportDocumentModal invoiceId="inv1" reportId="r1" onClose={() => {}} />)
    expect(screen.getByText(/งานหุ้ม \(การ์ดถูกลบ\)/)).toBeTruthy()
    expect(container.ownerDocument.querySelectorAll('img').length).toBe(0)
  })

  it('missing photo url is skipped', async () => {
    hookData = makeData({
      tasks: [{ id: 't1', phase_id: null, status: 'doing' }],
      photosByTask: { t1: [{ id: 'p1', photo_path: 'ok.jpg' }, { id: 'p2', photo_path: 'gone.jpg' }] },
      cards: [{ id: 'c1', task_id: 't1', card_title: 'การ์ด', photo_ids: ['p1', 'p2', 'p3'] }],
    })
    render(<DeliveryReportDocumentModal invoiceId="inv1" reportId="r1" onClose={() => {}} />)
    await waitFor(() => expect(document.querySelectorAll('img').length).toBe(1))
    expect(document.querySelector('img').getAttribute('src')).toBe('u:ok.jpg')
  })
})

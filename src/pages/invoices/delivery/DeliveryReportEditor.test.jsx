// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor, act } from '@testing-library/react'

let hookData = null
let rpcWorker = 'w1'
const saveMock = vi.fn(async () => ({ id: 'r-new' }))
const reissueMock = vi.fn(async () => ({ id: 'r-re' }))
const uploadMock = vi.fn(async () => ({ id: 'ph-new', photo_path: 't1/s1/new.jpg' }))

vi.mock('../../../hooks/useDeliveryReport.js', () => ({
  useDeliveryReport: () => ({ data: hookData, loading: false, error: null, refetch: () => {} }),
  saveDeliveryReport: (...a) => saveMock(...a),
  reissueDeliveryReport: (...a) => reissueMock(...a),
}))
vi.mock('../../../lib/photoUpload.js', () => ({
  uploadSitePhoto: (...a) => uploadMock(...a),
  bangkokTodayIso: () => '2026-10-23',
}))
vi.mock('../../../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: { id: 't1' } }) }))
vi.mock('../../../hooks/useBackToClose.js', () => ({ useBackToClose: () => {} }))
vi.mock('../../../lib/supabase.js', () => ({
  supabase: {
    rpc: async () => ({ data: rpcWorker }),
    storage: { from: () => ({ createSignedUrls: async paths => ({ data: paths.map(p => ({ signedUrl: 'u:' + p })) }) }) },
  },
  fmt: n => String(n),
}))

import DeliveryReportEditor from './DeliveryReportEditor.jsx'

const row = (o) => ({ key: 'k', description: 'd', phaseId: null, phaseName: '', value: 0, prev: 0, this: 0, remaining: 0, check: 'ok', reasons: [], ...o })
function makeData(over = {}) {
  return {
    invoice: { id: 'inv1', invoice_number: 'IN1', site_id: 's1' },
    reports: [], current: null, cards: [], plans: [], marksByPlan: {},
    phases: [{ id: 'pA', name: 'ผลิต' }, { id: 'pB', name: 'ติดตั้ง' }],
    rows: [
      row({ key: 'b1|pA', phaseId: 'pA', phaseName: 'ผลิต', value: 600, this: 0 }),
      row({ key: 'b1|pB', phaseId: 'pB', phaseName: 'ติดตั้ง', value: 400, this: 400 }),
    ],
    totals: { contract: 1000, prev: 0, this: 400, remaining: 600 },
    tasks: [
      { id: 'tA', phase_id: 'pA', name: 'การ์ดผลิต', boq_item_id: 'b1' },
      { id: 'tB', phase_id: 'pB', name: 'การ์ดติดตั้ง', boq_item_id: 'b1' },
      { id: 'tC', phase_id: 'pB', name: 'วัดงาน', boq_item_id: null },
    ],
    photosByTask: { tB: [{ id: 'ph1', task_id: 'tB', photo_path: 't1/s1/a.jpg' }] },
    ...over,
  }
}
const renderIt = () => render(<DeliveryReportEditor invoiceId="inv1" onClose={() => {}} onSaved={() => {}} />)

afterEach(() => { cleanup(); hookData = null; rpcWorker = 'w1'; vi.clearAllMocks() })

describe('DeliveryReportEditor', () => {
  it('pre-ticks phases billed on the invoice', () => {
    hookData = makeData()
    renderIt()
    expect(screen.getByLabelText('ส่งงวดนี้ ติดตั้ง').checked).toBe(true)
    expect(screen.getByLabelText('ส่งงวดนี้ ผลิต').checked).toBe(false)
    expect(screen.queryByText('การ์ดผลิต')).toBeNull()
    expect(screen.getByText('การ์ดติดตั้ง')).toBeTruthy()
  })

  it('unticking a phase hides its cards', () => {
    hookData = makeData()
    renderIt()
    fireEvent.click(screen.getByLabelText('ส่งงวดนี้ ติดตั้ง'))
    expect(screen.queryByText('การ์ดติดตั้ง')).toBeNull()
    fireEvent.click(screen.getByLabelText('ส่งงวดนี้ ผลิต'))
    expect(screen.getByText('การ์ดผลิต')).toBeTruthy()
  })

  it('no-BOQ card shows ไม่มี BOQ · 0%', () => {
    hookData = makeData()
    renderIt()
    const card = document.querySelector('[data-card="tC"]')
    expect(card.textContent).toContain('ไม่มี BOQ · 0%')
    expect(document.querySelector('[data-card="tB"]').textContent).not.toContain('ไม่มี BOQ')
  })

  it('＋ รูป calls uploadSitePhoto with taskId and ticks the new photo', async () => {
    hookData = makeData()
    renderIt()
    await act(async () => {})
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
    await act(async () => {
      fireEvent.change(screen.getByTestId('upload-tB'), { target: { files: [file] } })
    })
    await waitFor(() => expect(uploadMock).toHaveBeenCalled())
    expect(uploadMock.mock.calls[0][0]).toMatchObject({ taskId: 'tB', tenantId: 't1', workerId: 'w1', siteId: 's1', file })
    await waitFor(() => expect(document.querySelector('[data-photo="ph-new"]').getAttribute('aria-pressed')).toBe('true'))
  })

  it('uploads without a linked worker (workerId null) and shows upload errors inline', async () => {
    hookData = makeData()
    rpcWorker = null
    uploadMock.mockRejectedValueOnce(new Error('เน็ตหลุด'))
    renderIt()
    await act(async () => {})
    await act(async () => {
      fireEvent.change(screen.getByTestId('upload-tB'), { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] } })
    })
    await waitFor(() => expect(uploadMock).toHaveBeenCalled())
    expect(uploadMock.mock.calls[0][0].workerId).toBeNull()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('เน็ตหลุด'))
  })

  it('unticking a phase clears its card ticks', async () => {
    hookData = makeData()
    renderIt()
    fireEvent.click(document.querySelector('[data-photo="ph1"]'))
    fireEvent.click(screen.getByLabelText('ส่งงวดนี้ ติดตั้ง'))
    fireEvent.click(screen.getByLabelText('ส่งงวดนี้ ติดตั้ง'))
    expect(screen.getByLabelText('เลือกการ์ด การ์ดติดตั้ง').checked).toBe(false)
    expect(document.querySelector('[data-photo="ph1"]').getAttribute('aria-pressed')).toBe('false')
  })

  it('save sends phaseIds and ticked photoIds', async () => {
    hookData = makeData({ rows: [...makeData().rows, row({ key: 'x', description: 'เกิน', check: 'warn', reasons: ['over_billed'] })] })
    renderIt()
    expect(screen.getByTestId('dr-warnings').textContent).toContain('⚠️')
    fireEvent.click(document.querySelector('[data-photo="ph1"]'))
    await act(async () => { fireEvent.click(screen.getByText('บันทึกรายงาน')) })
    expect(saveMock).toHaveBeenCalledTimes(1)
    const arg = saveMock.mock.calls[0][0]
    expect(arg.phaseIds).toEqual(['pB'])
    expect(arg.reportId).toBeNull()
    expect(arg.cards).toEqual([{ taskId: 'tB', cardTitle: 'การ์ดติดตั้ง', photoIds: ['ph1'], caption: null }])
  })

  it('signed report reissues instead of saving in place', async () => {
    hookData = makeData({ current: { id: 'r1', status: 'signed', phase_ids: ['pB'], report_number: 'DR1' },
      cards: [{ task_id: 'tB', photo_ids: ['ph1'], caption: 'c' }] })
    renderIt()
    await act(async () => { fireEvent.click(screen.getByText('บันทึกรายงาน')) })
    expect(saveMock).not.toHaveBeenCalled()
    expect(reissueMock.mock.calls[0][1].cards[0]).toMatchObject({ taskId: 'tB', photoIds: ['ph1'], caption: 'c' })
  })

  it('shows the Thai error from save', async () => {
    hookData = makeData()
    saveMock.mockRejectedValueOnce(new Error('รายงานที่เซ็นแล้วแก้ไม่ได้ กรุณาออกฉบับใหม่'))
    renderIt()
    await act(async () => { fireEvent.click(screen.getByText('บันทึกรายงาน')) })
    expect(screen.getByRole('alert').textContent).toContain('รายงานที่เซ็นแล้วแก้ไม่ได้')
  })
})

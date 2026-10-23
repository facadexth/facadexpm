// @vitest-environment jsdom
// Easy mode: quantity or baht amount per line, whole numbers for typed count-unit qty,
// and a ✅/⚠️/⛔ check icon per line when the site has BOQ rows.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'

let pbData = null
const UNITS = {
  qi1: [{ id: 'u1', unit_index: 0, unit_qty: 2, cumulative_pct: 0 }],
  qi2: [{ id: 'u2', unit_index: 0, unit_qty: 26, cumulative_pct: 0 }],
}

vi.mock('../hooks/useSupabase.js', () => {
  const none = () => ({ data: null, loading: false, error: null, refetch: () => {} })
  return {
    useInvoices: none, useQuotations: none, useSites: none, useReceipts: none, useInvoicePhotos: none,
    useDocumentReceipt: none, useDocumentSigner: none, useBankAccounts: none, useSiteDepositBalance: none,
    useQuotationDepositTaxOffset: () => ({ data: 0 }), getQuotationDepositTaxOffset: async () => 0,
    logDocumentPrint: async () => {}, useInvoiceDepositChoiceReady: () => false,
    useSiteReservedDeposit: () => ({ data: { total: 0, invoices: [] } }),
    useQuotationItemUnits: () => ({ data: UNITS, loading: false, error: null }),
  }
})
vi.mock('../hooks/useProgressBillingData.js', () => ({
  useProgressBillingData: () => ({ data: pbData, loading: false, error: null }),
}))
vi.mock('../hooks/useTenant.js', () => ({ useTenant: () => ({ hasModuleAccess: () => false }) }))
vi.mock('../hooks/useUserRole.js', () => ({ useUserRole: () => ({}) }))
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: () => ({}) },
  fmt: n => String(n), fmtDate: d => String(d),
}))

import { CreateInvoiceModal } from './Invoices.jsx'

const quotation = {
  id: 'q1', site_id: 's1', quotation_number: 'QT1', has_vat: false, price_includes_vat: false,
  quotation_items: [
    { id: 'qi1', description: 'ประตู', unit: 'ชุด', unit_price: 1000, quantity: 2, line_total: 2000 },
    { id: 'qi2', description: 'ผนัง', unit: 'ตร.ม.', unit_price: 100, quantity: 26, line_total: 2600 },
  ],
}

const renderModal = () => render(<CreateInvoiceModal quotation={quotation} site={{}} onClose={() => {}} onSaved={() => {}} />)
const qtyInputs = () => screen.getAllByRole('spinbutton').filter(i => i.closest('[data-line]') && i.classList.contains('num-spin'))
const amtInputs = () => [...document.querySelectorAll('[title="กรอกจำนวนเงินที่ต้องการเรียกเก็บสำหรับรายการนี้"]')]
const untickAll = () => fireEvent.click(screen.getByLabelText('เลือกทั้งหมด'))

afterEach(() => { cleanup(); pbData = null })

describe('easy mode', () => {
  it('keeps the per-line amount input next to qty', () => {
    renderModal()
    expect(amtInputs()).toHaveLength(2)
    expect(qtyInputs()).toHaveLength(2)
  })

  it('a baht amount giving a fraction of a ชุด is allowed (no block)', () => {
    renderModal()
    untickAll()
    fireEvent.change(amtInputs()[0], { target: { value: '800' } })
    expect(screen.queryByText(/ต้องเป็นจำนวนเต็ม/)).toBeNull()
    expect(screen.getByText('✅ สร้างใบแจ้งหนี้').closest('button').disabled).toBe(false)
  })

  it('blocks a fractional qty on a ชุด line', () => {
    renderModal()
    untickAll()
    fireEvent.change(qtyInputs()[0], { target: { value: '0.8' } })
    expect(screen.getByText('ต้องเป็นจำนวนเต็ม (หน่วย ชุด)')).toBeTruthy()
    expect(screen.getByText('✅ สร้างใบแจ้งหนี้').closest('button').disabled).toBe(true)
  })

  it('accepts 12.5 on a ตร.ม. line', () => {
    renderModal()
    untickAll()
    fireEvent.change(qtyInputs()[1], { target: { value: '12.5' } })
    expect(screen.queryByText(/ต้องเป็นจำนวนเต็ม/)).toBeNull()
    expect(screen.getByText('✅ สร้างใบแจ้งหนี้').closest('button').disabled).toBe(false)
  })

  it('warns when qty looks like BOQ qty x %', () => {
    pbData = {
      boqByQuotationItem: { qi2: { id: 'b2', unit: 'ตร.ม.', planned_qty: 26, code: 'A' } },
      splitsByBoq: { b2: [{ phase_id: 'p1', pct: 20 }, { phase_id: 'p2', pct: 60 }, { phase_id: 'p3', pct: 20 }] },
      phases: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
      cards: [
        { boq_item_id: 'b2', phase_id: 'p1', done_qty: 26, planned_qty: 26, progress_mode: 'quantity' },
        { boq_item_id: 'b2', phase_id: 'p2', done_qty: 26, planned_qty: 26, progress_mode: 'quantity' },
        { boq_item_id: 'b2', phase_id: 'p3', done_qty: 0, planned_qty: 26, progress_mode: 'quantity' },
      ],
      phaseDraws: [],
    }
    renderModal()
    untickAll()
    fireEvent.change(qtyInputs()[1], { target: { value: '20.8' } })
    expect(document.querySelector('[title="ปริมาณเท่ากับ 26 × 80% อาจใช้ % ของปริมาณ"]')).toBeTruthy()
  })

  it('shows no weight/card warnings in easy mode (full qty, phases partly done)', () => {
    pbData = {
      boqByQuotationItem: { qi2: { id: 'b2', unit: 'ตร.ม.', planned_qty: 26, code: 'A' } },
      splitsByBoq: { b2: [{ phase_id: 'p1', pct: 20 }, { phase_id: 'p2', pct: 80 }] },
      phases: [{ id: 'p1' }, { id: 'p2' }],
      cards: [
        { boq_item_id: 'b2', phase_id: 'p1', done_qty: 10, planned_qty: 26, progress_mode: 'quantity' },
        { boq_item_id: 'b2', phase_id: 'p2', done_qty: 0, planned_qty: 26, progress_mode: 'quantity' },
      ],
      phaseDraws: [],
    }
    renderModal()
    untickAll()
    fireEvent.change(qtyInputs()[1], { target: { value: '26' } })
    expect(document.querySelector('[title="ตรงกับ BOQ และการ์ด"]')).toBeTruthy()
  })

  it('shows the ตามความคืบหน้า mode button only when the site has BOQ rows', () => {
    renderModal()
    expect(screen.queryByText('ตามความคืบหน้า')).toBeNull()
    cleanup()
    pbData = { boqByQuotationItem: { qi1: { id: 'b1', unit: 'ชุด', planned_qty: 2 } }, splitsByBoq: {}, phases: [], cards: [], phaseDraws: [] }
    renderModal()
    expect(screen.getByText('ตามความคืบหน้า')).toBeTruthy()
  })
})

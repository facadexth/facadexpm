// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'

const invoke = vi.fn()
vi.mock('./lib/supabase.js', () => ({ supabase: { functions: { invoke: (...a) => invoke(...a) } } }))
vi.mock('./lib/pdf.js', () => ({ downloadPDF: vi.fn() }))
vi.mock('./components/SignaturePad.jsx', () => ({ default: () => null }))

import PublicSignPage from './PublicSignPage.jsx'

const repairDoc = {
  type: 'repair_ticket', label: 'ใบงานซ่อม RP2611-007', number: 'RP2611-007', date: '2026-11-25',
  tenant_id: 't1', clientName: 'สมชาย', siteName: 'บ้านคุณสมชาย', notes: null,
  items: [
    { description: 'ห้องนอน (ชั้น 2) — รั่วซึม: มุมหน้าต่าง' },
    { description: 'ห้องครัว — กระจกแตก' },
  ],
}
const reply = (data) => invoke.mockImplementation(async () => ({ data, error: null }))

beforeEach(() => { cleanup(); invoke.mockReset() })

describe('PublicSignPage repair_ticket', () => {
  it('shows a numbered รายการซ่อม list and no money', async () => {
    reply({ valid: true, alreadySigned: false, document: repairDoc, tenant: null, tenantName: 'FacadeX' })
    render(<PublicSignPage linkId="L1" />)
    fireEvent.click(await screen.findByRole('button', { name: /ดูเอกสารที่กำลังจะเซ็น/ }))
    const paper = document.getElementById('sign-doc-paper')
    expect(within(paper).getByText('รายการซ่อม')).toBeTruthy()
    const list = paper.querySelector('ol')
    expect(list).toBeTruthy()
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(repairDoc.items.map((i) => i.description))
    const text = document.body.textContent
    expect(text).not.toMatch(/฿|บาท|ราคา|รวมทั้งสิ้น|VAT|ยอดรวม/)
    expect(paper.querySelector('table')).toBeNull()
  })

  it('after signing still shows no money', async () => {
    reply({ valid: true, alreadySigned: true, document: repairDoc, tenant: null, tenantName: 'FacadeX', signature: { url: 'https://sig', signerName: 'สมชาย', signedAt: '2026-11-25T03:00:00Z' } })
    render(<PublicSignPage linkId="L1" />)
    await screen.findByText(/เซ็นรับเรียบร้อยแล้ว/)
    expect(document.body.textContent).not.toMatch(/฿|บาท|ราคา|รวมทั้งสิ้น|VAT/)
    expect(screen.getByText('ห้องครัว — กระจกแตก')).toBeTruthy()
  })

  it('a declined ticket shows the repair cancelled message', async () => {
    reply({ valid: false, reason: 'replaced', documentType: 'repair_ticket' })
    render(<PublicSignPage linkId="L1" />)
    expect(await screen.findByText('งานซ่อมนี้ถูกยกเลิกแล้ว')).toBeTruthy()
  })

  it('a replaced delivery report keeps its old message', async () => {
    reply({ valid: false, reason: 'replaced' })
    render(<PublicSignPage linkId="L1" />)
    expect(await screen.findByText('รายงานนี้ถูกแทนด้วยฉบับใหม่')).toBeTruthy()
  })
})

describe('PublicSignPage invoice (unchanged)', () => {
  it('still shows money columns and the total', async () => {
    reply({ valid: true, alreadySigned: false, tenant: null, tenantName: 'FacadeX', document: {
      type: 'invoice', label: 'ใบแจ้งหนี้ IN1', date: '2026-11-25', hasVat: true, subtotal: 100, vat: 7, total: 107,
      items: [{ description: 'งาน', unit: 'ชุด', quantity: 1, unitPrice: 100, lineTotal: 100 }],
    } })
    render(<PublicSignPage linkId="L1" />)
    fireEvent.click(await screen.findByRole('button', { name: /ดูเอกสารที่กำลังจะเซ็น/ }))
    expect(screen.getByText('ราคา/หน่วย')).toBeTruthy()
    expect(screen.getByText(/ยอดรวม: 107\.00 บาท/)).toBeTruthy()
  })
})

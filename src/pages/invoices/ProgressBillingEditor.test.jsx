// @vitest-environment jsdom
// Progress ("ตามความคืบหน้า") mode: rows built from card progress x BOQ phase weight.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { useState } from 'react'

vi.mock('../../lib/supabase.js', () => ({ fmt: n => String(n) }))

import ProgressBillingEditor, { buildProgressInvoiceRows } from './ProgressBillingEditor.jsx'

const unit = (id, qty, pct = 0) => ({ id, unitIndex: 0, unitQty: qty, cumulativePct: pct })

// SOAP OPERA-like numbers
const lines = [
  { quotationItemId: 'qAD1', description: 'AD1', unit: 'ชุด', unitPrice: 41000, baseUnitPrice: 41000, totalQty: 1, units: [unit('u1', 1)] },
  { quotationItemId: 'qW', description: 'ผนัง', unit: 'ตร.ม.', unitPrice: 3554.46, baseUnitPrice: 3900, totalQty: 26, units: [unit('u2', 26)] },
  { quotationItemId: 'qS', description: 'ประตูสถานะ', unit: 'ชุด', unitPrice: 16405.2, baseUnitPrice: 18000, totalQty: 1, units: [unit('u3', 1)] },
]
const data = {
  boqByQuotationItem: {
    qAD1: { id: 'bAD1', unit: 'ชุด', planned_qty: 1, code: 'AD1' },
    qW: { id: 'bW', unit: 'ตร.ม.', planned_qty: 26, code: 'W' },
    qS: { id: 'bS', unit: 'ชุด', planned_qty: 1, code: 'S' },
  },
  splitsByBoq: {
    bAD1: [{ phase_id: 'pP', pct: 40 }, { phase_id: 'pI', pct: 40 }, { phase_id: 'pH', pct: 20 }],
    bW: [{ phase_id: 'pP', pct: 20 }, { phase_id: 'pI', pct: 60 }, { phase_id: 'pH', pct: 20 }],
    bS: [{ phase_id: 'pP', pct: 40 }, { phase_id: 'pI', pct: 40 }, { phase_id: 'pH', pct: 20 }],
  },
  phases: [{ id: 'pP', name: 'ผลิต', sort_order: 1 }, { id: 'pI', name: 'ติดตั้ง', sort_order: 2 }, { id: 'pH', name: 'ส่งมอบ', sort_order: 3 }],
  cards: [
    { boq_item_id: 'bAD1', phase_id: 'pP', done_qty: 1, planned_qty: 1, progress_mode: 'quantity', name: 'AD1 ผลิต' },
    { boq_item_id: 'bAD1', phase_id: 'pI', done_qty: 1, planned_qty: 1, progress_mode: 'quantity', name: 'AD1 ติดตั้ง' },
    { boq_item_id: 'bW', phase_id: 'pP', done_qty: 20, planned_qty: 26, progress_mode: 'quantity', name: 'ผนัง ผลิต' },
    { boq_item_id: 'bW', phase_id: 'pI', done_qty: 0, planned_qty: 26, progress_mode: 'quantity', name: 'ผนัง ติดตั้ง' },
    { boq_item_id: 'bS', phase_id: 'pP', done_qty: 0, planned_qty: null, progress_mode: 'status', name: 'การ์ดประตู' },
  ],
  phaseDraws: [],
}
const PM = 1

describe('buildProgressInvoiceRows', () => {
  it('bills AD1 ผลิต + ติดตั้ง at 80%', () => {
    const r = buildProgressInvoiceRows(lines, data, { phaseIds: [], rows: { qAD1: { phaseIds: ['pP', 'pI'] } } }, PM)
    expect(r.blocked).toBe(false)
    expect(r.items).toHaveLength(1)
    const it = r.items[0]
    expect(it).toMatchObject({ quotationItemId: 'qAD1', description: 'AD1 (ผลิต + ติดตั้ง 80%)', drawQty: 1, unitPrice: 32800, lineTotal: 32800, unit: 'ชุด' })
    expect(it.phases).toEqual([
      { boq_item_id: 'bAD1', phase_id: 'pP', qty: 1, weight_pct: 40, amount: 16400 },
      { boq_item_id: 'bAD1', phase_id: 'pI', qty: 1, weight_pct: 40, amount: 16400 },
    ])
  })

  it('bills composite ผลิต only, qty 20', () => {
    const r = buildProgressInvoiceRows(lines, data, { phaseIds: [], rows: { qW: { phaseIds: ['pP'] } } }, PM)
    expect(r.items[0]).toMatchObject({ drawQty: 20, lineTotal: 14217.84, description: 'ผนัง (ผลิต 20%)' })
  })

  it('blocks a line whose card has no quantity', () => {
    const r = buildProgressInvoiceRows(lines, data, { phaseIds: [], rows: { qS: { phaseIds: ['pP'] } } }, PM)
    expect(r.blocked).toBe(true)
    expect(r.status.qS.blockedCard).toBe('การ์ดประตู')
  })

  it('subtracts delivered-before (ignoring void) and never raises qty above it', () => {
    const d = { ...data, phaseDraws: [
      { boq_item_id: 'bW', phase_id: 'pP', qty: 8, invoice_status: 'paid' },
      { boq_item_id: 'bW', phase_id: 'pP', qty: 5, invoice_status: 'void' },
    ] }
    const r = buildProgressInvoiceRows(lines, d, { phaseIds: [], rows: { qW: { phaseIds: ['pP'], qty: 50 } } }, PM)
    expect(r.items[0].drawQty).toBe(12)
    const lower = buildProgressInvoiceRows(lines, d, { phaseIds: [], rows: { qW: { phaseIds: ['pP'], qty: 5 } } }, PM)
    expect(lower.items[0].drawQty).toBe(5)
  })

  it('caps the amount at the remaining value of the item', () => {
    const partly = lines.map(l => l.quotationItemId === 'qAD1' ? { ...l, units: [unit('u1', 1, 50)] } : l)
    const r = buildProgressInvoiceRows(partly, data, { phaseIds: [], rows: { qAD1: { phaseIds: ['pP', 'pI'] } } }, PM)
    expect(r.items[0].lineTotal).toBe(20500)
  })

  it('uses header phases when a row has no override', () => {
    const r = buildProgressInvoiceRows(lines, data, { phaseIds: ['pP'], rows: {} }, PM)
    expect(r.items.map(i => i.quotationItemId)).toEqual(['qAD1', 'qW'])
    expect(r.blocked).toBe(true) // qS card has no qty
  })
})

function Harness({ initial = { phaseIds: [], rows: {} } }) {
  const [value, setValue] = useState(initial)
  return (
    <div>
      <ProgressBillingEditor lines={lines} data={data} priceMultiplier={PM} value={value} onChange={setValue} />
      <pre data-testid="value">{JSON.stringify(value)}</pre>
    </div>
  )
}
const valueOf = () => JSON.parse(screen.getByTestId('value').textContent)

afterEach(cleanup)

describe('ProgressBillingEditor', () => {
  it('header phase chips set every row', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'ทุกรายการ: ผลิต' }))
    const v = valueOf()
    expect(v.phaseIds).toEqual(['pP'])
    expect(v.rows.qAD1.phaseIds).toEqual(['pP'])
    expect(v.rows.qW.phaseIds).toEqual(['pP'])
  })

  it("a row's chips override the header", () => {
    render(<Harness initial={{ phaseIds: ['pP'], rows: { qAD1: { phaseIds: ['pP'] }, qW: { phaseIds: ['pP'] } } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'AD1: ติดตั้ง' }))
    const v = valueOf()
    expect(v.rows.qAD1.phaseIds).toEqual(['pP', 'pI'])
    expect(v.rows.qW.phaseIds).toEqual(['pP'])
  })

  it('the blocked row shows a กรอกในการ์ด button with a hint', () => {
    render(<Harness initial={{ phaseIds: [], rows: { qS: { phaseIds: ['pP'] } } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'กรอกในการ์ด →' }))
    expect(screen.getByText('ไปกรอกจำนวนในการ์ด การ์ดประตู ที่หน้าไซท์ → Kanban')).toBeTruthy()
  })
})

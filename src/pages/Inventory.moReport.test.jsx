// @vitest-environment jsdom
// Tab 2 (MO) document body: the requisitioned items from the DM children,
// grouped by category with subtotals — no % targets, no shortfall column
// (owner ruling 2026-10-27). The list view keeps its target/short columns.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../hooks/useIsPhone.js', () => ({ useIsPhone: () => false, PHONE_QUERY: '(max-width: 900px)' }))
vi.mock('../lib/supabase.js', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    supabase: {
      from: () => ({}), rpc: () => ({}),
      auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      channel: () => ({ on() { return this }, subscribe() { return this } }),
      removeChannel: () => {},
    },
  }
})

import { MoReportView } from './Inventory.jsx'

const CATEGORIES = [{ id: 'c-glass', name: 'กระจก' }, { id: 'c-alu', name: 'อลูมิเนียม' }]
const ITEMS = [
  { id: 'it-g', code: 'GL-01', name: 'กระจกใส 10 มม.', base_unit: 'แผ่น', category_id: 'c-glass' },
  { id: 'it-a', code: 'AL-01', name: 'เฟรมอลูมิเนียม', base_unit: 'กิโลกรัม', category_id: 'c-alu' },
]
const DOCS = [
  { id: 'mo1', doc_type: 'MO', doc_number: 'MO2601-001', doc_date: '2026-01-06', invoice_id: 'inv1', target_total: 100, target_splits: { 'c-glass': 60, 'c-alu': 40 } },
  { id: 'dm1', doc_type: 'DM', doc_number: 'DM2601-001', doc_date: '2026-01-06', parent_document_id: 'mo1' },
]
const MOVEMENTS = [
  { stock_document_id: 'dm1', movement_type: 'sale_out', inventory_item_id: 'it-g', quantity: 2, unit_cost: 30, sites: { name: 'ส่วนกลาง' } },
  { stock_document_id: 'dm1', movement_type: 'sale_out', inventory_item_id: 'it-a', quantity: 1.5, unit_cost: 20, sites: { name: 'ส่วนกลาง' } },
  { stock_document_id: 'mo1', movement_type: 'purchase_in', inventory_item_id: 'it-fg', quantity: 1, unit_cost: 90, sites: { name: 'ไซต์ เอ' } },
]

const renderView = () => render(
  <MoReportView stockDocuments={DOCS} movements={MOVEMENTS}
    invoiceNumbers={[{ id: 'inv1', invoice_number: 'IN2601-001' }]}
    categories={CATEGORIES} items={ITEMS}
    tenant={{ company_name: 'บจก. ทดสอบ' }} dateFrom="2026-01-01" dateTo="2026-12-31" />
)

afterEach(cleanup)

describe('MO document body (tab 2)', () => {
  it('list keeps target/short; document shows items per category without %/target/short', () => {
    const { container, getByText } = renderView()
    // List view: target and short columns stay.
    expect(container.textContent).toContain('เป้ามูลค่า')
    expect(container.textContent).toContain('ขาด')
    fireEvent.click(getByText('ดูใบสั่งผลิต →'))

    const text = container.textContent
    // Item lines with code / name / qty / unit / unit cost / value.
    expect(text).toContain('GL-01')
    expect(text).toContain('กระจกใส 10 มม.')
    expect(text).toContain('แผ่น')
    expect(text).toContain('AL-01')
    // Category bands + subtotals (glass 2×30 = 60, alu 1.5×20 = 30), grand total 90.
    expect(text).toContain('รวมหมวดกระจก')
    expect(text).toContain('รวมหมวดอลูมิเนียม')
    expect(text).toContain('60.00')
    expect(text).toContain('30.00')
    expect(text).toContain('รวมทั้งสิ้น')
    expect(text).toContain('90.00')
    // Header info survives; the %/target/short columns are gone from the document.
    expect(text).toContain('IN2601-001')
    expect(text).toContain('DM2601-001')
    expect(text).not.toContain('% ที่ตั้ง')
    expect(text).not.toContain('เป้ามูลค่า (บาท)')
    expect(text).not.toContain('ขาด (บาท)')
    // Higher split % orders first: glass (60) before alu (40).
    expect(text.indexOf('รวมหมวดกระจก')).toBeLessThan(text.indexOf('รวมหมวดอลูมิเนียม'))
  })

  it('an MO with no DM sale_out rows shows the empty-body row', () => {
    const { container, getByText } = render(
      <MoReportView stockDocuments={[DOCS[0]]} movements={[]} invoiceNumbers={[]}
        categories={CATEGORIES} items={ITEMS} tenant={{ company_name: 'บจก. ทดสอบ' }}
        dateFrom="2026-01-01" dateTo="2026-12-31" />
    )
    fireEvent.click(getByText('ดูใบสั่งผลิต →'))
    expect(container.textContent).toContain('ไม่มีรายการเบิกวัตถุดิบ')
  })
})

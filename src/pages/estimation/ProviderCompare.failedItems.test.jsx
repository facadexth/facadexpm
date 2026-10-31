// @vitest-environment jsdom
// The comparison row names the real reason an item could not be priced (e.g. the family has no series for its type),
// instead of blaming missing profiles or prices.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: { from: () => ({}) }, fmt: n => String(n) }))
vi.mock('../../lib/providerCompare.js', async orig => ({
  ...(await orig()),
  compareProviders: ctx => ctx.candidates.map(c => (c.providerId === 'A'
    ? { ...c, aluminium: 1000, unresolvedLines: 0, itemsPriced: 1, failedItems: [], complete: true }
    : { ...c, aluminium: 0, unresolvedLines: 2, itemsPriced: 0, failedItems: [{ id: 'i1', opening_no: 'W1', text: 'ซีรีส์หลักนี้ไม่มีชุดสำหรับประเภทนี้' }], complete: false })),
}))
const { default: ProviderCompare } = await import('./ProviderCompare.jsx')

afterEach(cleanup)

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'A-Alu' }, { id: 'B', name: 'B-Alu' }],
  seriesFamilies: [{ id: 'famA', provider_id: 'A', name: 'EURO' }, { id: 'famB', provider_id: 'B', name: 'ICON' }],
  series: [{ id: 'sA', provider_id: 'A', name: 'EURO 1', series_family_id: 'famA' }, { id: 'sB', provider_id: 'B', name: 'ICON 1', series_family_id: 'famB' }],
  types: [], seriesTypes: [],
  finishes: [{ id: 'fA', provider_id: 'A', name: 'ขาว A' }, { id: 'fB', provider_id: 'B', name: 'ขาว B' }],
  profiles: [], seriesProfiles: [], kgPrices: [],
})
const project = { id: 'p1', primary_provider_id: 'A', default_series_family_id: 'famA', default_finish_id: 'fA', price_as_of: '2026-06-01' }
const base = { templatesById: {}, componentsByTemplate: {}, jointsByTemplate: {}, typesById: {}, infillTypesById: {}, settings: {} }
const items = [{ id: 'i1', opening_no: 'W1', quantity: 2 }]

describe('ProviderCompare per-item reasons', () => {
  it('shows the family-coverage reason with the item number, not "ไม่มีหน้าตัด/ราคา"', () => {
    const r = render(<ProviderCompare project={project} items={items} base={base} index={index} seriesTypes={[]} canEdit onApplied={vi.fn()} />)
    const row = r.getByText('B-Alu').closest('tr')
    const [famSel, finSel] = row.querySelectorAll('select')
    fireEvent.change(famSel, { target: { value: 'famB' } })
    fireEvent.change(finSel, { target: { value: 'fB' } })
    expect(row.textContent).toContain('คิดไม่ได้ 2 รายการ · ซีรีส์หลักนี้ไม่มีชุดสำหรับประเภทนี้: W1')
    expect(row.textContent).not.toContain('ไม่มีหน้าตัด/ราคา')
  })
})

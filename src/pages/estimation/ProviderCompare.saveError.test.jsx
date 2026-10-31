// @vitest-environment jsdom
// A failed save after ยืนยัน closes the confirm dialog (a full-screen overlay) so the card's error is visible.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'

const eq = vi.fn(async () => ({ error: { message: 'boom' } }))
vi.mock('../../lib/supabase.js', () => ({ supabase: { from: () => ({ update: () => ({ eq }) }) }, fmt: n => String(n) }))
vi.mock('../../lib/providerCompare.js', async orig => ({
  ...(await orig()),
  compareProviders: ctx => ctx.candidates.map(c => ({ ...c, aluminium: c.providerId === 'A' ? 1000 : 900, unresolvedLines: 0, itemsPriced: 1, failedItems: [], complete: true })),
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

const setup = () => {
  const r = render(<ProviderCompare project={project} items={[]} base={base} index={index} seriesTypes={[]} canEdit onApplied={vi.fn()} />)
  const row = r.getByText('B-Alu').closest('tr')
  const [famSel, finSel] = row.querySelectorAll('select')
  fireEvent.change(famSel, { target: { value: 'famB' } })
  fireEvent.change(finSel, { target: { value: 'fB' } })
  fireEvent.click(r.getByText('ใช้โรงรีดนี้'))
  return r
}

describe('ProviderCompare save error', () => {
  it('a rejected save closes the dialog and shows the error in the card', async () => {
    const r = setup()
    expect(document.querySelector('.modal-overlay')).not.toBeNull()
    fireEvent.click(r.getByText('ยืนยัน'))
    await waitFor(() => expect(r.getByRole('alert').textContent).toContain('บันทึกไม่สำเร็จ: boom'))
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })
  it('cancelling the dialog clears a shown error', async () => {
    const r = setup()
    fireEvent.click(r.getByText('ยืนยัน'))
    await waitFor(() => expect(r.queryByRole('alert')).not.toBeNull())
    fireEvent.click(r.getByText('ใช้โรงรีดนี้'))
    fireEvent.click(r.getByText('ยกเลิก'))
    expect(r.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })
})

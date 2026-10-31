// @vitest-environment jsdom
// The defaults card collapses after save, opens collapsed when set, expanded when new, and never loses unsaved edits.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'

const update = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }))
vi.mock('../../lib/supabase.js', () => ({ supabase: { from: () => ({ update }) } }))
const { default: ProjectDefaultsPanel } = await import('./ProjectDefaultsPanel.jsx')

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'บจก. อลูเม็ท (Alumet)' }],
  seriesFamilies: [{ id: 'fI', provider_id: 'A', name: 'ICONIQ EURO' }],
  series: [{ id: 's1', provider_id: 'A', name: 'ICONIQ EURO บานเลื่อน', series_family_id: 'fI' }],
})
const saved = { id: 'p1', primary_provider_id: 'A', default_series_family_id: 'fI', profit_pct: 50, price_as_of: '2026-10-09' }
const mount = (project, onSaved = vi.fn(async () => {})) => render(
  <ProjectDefaultsPanel project={project} index={index} seriesTypes={[]} infillTypes={[]} packages={[]} items={[]} templatesById={{}} canEdit onSaved={onSaved} />,
)
afterEach(cleanup)

describe('ProjectDefaultsPanel collapse', () => {
  it('a project with saved defaults opens collapsed with its chips', () => {
    mount(saved)
    expect(screen.getByText('✓ บันทึกแล้ว')).toBeTruthy()
    expect(screen.getByText('แก้ไข ▾')).toBeTruthy()
    expect(screen.getByText('ICONIQ EURO')).toBeTruthy()
    expect(screen.getByText('9 ต.ค. 2569')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /บันทึกค่าเริ่มต้น/ })).toBeNull()
  })
  it('a new project opens expanded', () => {
    mount({ id: 'p2', profit_pct: 30, price_as_of: '2026-10-31' })
    expect(screen.getByText('ย่อ ▴')).toBeTruthy()
    expect(screen.getByRole('button', { name: /บันทึกค่าเริ่มต้น/ })).toBeTruthy()
  })
  it('collapsing keeps an unsaved edit, and says it is not saved', () => {
    const { container } = mount(saved)
    fireEvent.click(screen.getByText('แก้ไข ▾'))
    fireEvent.change(container.querySelector('input[max="1000"]'), { target: { value: '60' } })
    fireEvent.click(screen.getByText('ย่อ ▴'))
    expect(screen.getByText('มีค่าที่ยังไม่บันทึก')).toBeTruthy()
    fireEvent.click(screen.getByText('แก้ไข ▾'))
    expect(container.querySelector('input[max="1000"]').value).toBe('60')
  })
  it('saving collapses the card', async () => {
    const onSaved = vi.fn(async () => {})
    const { container } = mount(saved, onSaved)
    fireEvent.click(screen.getByText('แก้ไข ▾'))
    fireEvent.change(container.querySelector('input[max="1000"]'), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: /บันทึกค่าเริ่มต้น/ }))
    await waitFor(() => expect(screen.getByText('แก้ไข ▾')).toBeTruthy())
    expect(update).toHaveBeenCalledWith({ profit_pct: 60 })
    expect(onSaved).toHaveBeenCalled()
  })
})

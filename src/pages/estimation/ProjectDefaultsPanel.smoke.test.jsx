// SSR smoke: the defaults form offers ซีรีส์หลัก (families of the main extruder) and shows the saved one.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {} }))
const { default: ProjectDefaultsPanel } = await import('./ProjectDefaultsPanel.jsx')

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'บจก. อลูเม็ท (Alumet)' }],
  seriesFamilies: [{ id: 'fI', provider_id: 'A', name: 'ICONIQ EURO' }],
  series: [
    { id: 's1', provider_id: 'A', name: 'ICONIQ EURO บานเลื่อน', series_family_id: 'fI' },
    { id: 's2', provider_id: 'A', name: 'ICONIQ EURO บานเปิด / บานกระทุ้ง', series_family_id: 'fI' },
    { id: 's3', provider_id: 'A', name: 'ICONIQ EURO บานติดตาย', series_family_id: 'fI' },
  ],
})
const clean = h => h.replace(/<!-- -->/g, '')
const render = project => clean(renderToString(
  <ProjectDefaultsPanel project={project} index={index} seriesTypes={[]} infillTypes={[]} packages={[]} items={[]} templatesById={{}} canEdit onSaved={async () => {}} />,
))

describe('ProjectDefaultsPanel: ซีรีส์หลัก', () => {
  it('a new project: expanded form with the family choices of the main extruder', () => {
    const h = render({ id: 'p1', primary_provider_id: null, profit_pct: 30, price_as_of: '2026-10-31' })
    expect(h).toContain('ซีรีส์หลัก')
    expect(h).toContain('ICONIQ EURO · 3 ชุด')
    expect(h).not.toMatch(/NaN|undefined/)
  })
})

// Render smoke test (server-side only): a layout_kind template shows the part-editor drawing with only the double-line
// and solid styles; a legacy template keeps the four styles.
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import PreviewPanel from './PreviewPanel.jsx'
import { startModel } from '../../lib/partModel.js'

const model = (() => {
  const m = startModel('sliding_2')
  for (const k of Object.keys(m.lines)) m.lines[k][0].profile_family = k.startsWith('frame') ? 'FR' : 'SA'
  return m
})()
const legacyInputs = { template: { id: 't', preview_kind: 'slide', grid_row_weights: [1] }, width_m: 1.8, height_m: 1.2, panel_count: 2, main_axis: 'horizontal', addon: null }

describe('PreviewPanel', () => {
  it('(g) layout_kind: renders the part drawing, offers only double-line and solid', () => {
    const html = renderToString(<PreviewPanel inputs={legacyInputs} part={{ model, buttOf: () => 20, widthMm: 1800, heightMm: 1200 }} />)
    expect(html).toContain('data:image/svg+xml')
    const svg = decodeURIComponent(html.match(/src="data:image\/svg\+xml;charset=utf-8,([^"]+)"/)[1].replace(/&amp;/g, '&'))
    expect(svg).toContain('1.80 ม.')
    expect(html + svg).not.toMatch(/NaN|undefined/)
    expect(html).toContain('เส้นคู่')
    expect(html).toContain('สีทึบ')
    expect(html).not.toContain('เส้นเดียว (CAD)')
    expect(html).not.toContain('บอกความยาวชิ้นส่วน')
  })
  it('legacy templates still offer the four styles and draw the legacy preview', () => {
    const html = renderToString(<PreviewPanel inputs={legacyInputs} />)
    expect(html).toContain('เส้นเดียว (CAD)')
    expect(html).toContain('บอกความยาวชิ้นส่วน')
    expect(html).not.toContain('data:image/svg+xml')
  })
})

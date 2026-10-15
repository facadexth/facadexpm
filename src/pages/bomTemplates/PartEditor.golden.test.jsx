// Golden render of the sliding_2 part editor with no add-on props (Task 6 rule): the add-on box, overview add-ons and
// zoom card must not change a single byte of the editor for a template without preview add-ons or piece sets.
// Fixture written from commit 77a2e87a (before the add-on UI). Regenerate ONLY on a deliberate editor change:
//   UPDATE_GOLDEN=1 npx vitest run src/pages/bomTemplates/PartEditor.golden.test.jsx
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { startModel } from '../../lib/partModel.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => (n == null || isNaN(n) ? '—' : Number(n).toFixed(2)) }))
const { default: PartEditor } = await import('./PartEditor.jsx')

const FAMS = { FT: [58.1, 38.1], FB: [55.6, 35.8], FS: [51.3, 38.1], ST: [25, 25], SB: [25, 25], KS: [25, 25], HS: [25, 25] }
const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'โรงรีด A', price_basis: 'per_kg' }],
  series: [{ id: 'sA', provider_id: 'A', name: 'MNG' }],
  types: [{ id: 'slide', name: 'บานเลื่อน' }],
  seriesTypes: [{ series_id: 'sA', type_id: 'slide' }],
  finishes: [],
  profiles: Object.entries(FAMS).map(([f, [w, b]]) => ({ id: 'p' + f, provider_id: 'A', family: f, thickness_mm: 1.5, width_mm: w, butt_distance_mm: b, linear_weight_kg_per_m: 1 })),
  seriesProfiles: Object.keys(FAMS).map(f => ({ series_id: 'sA', profile_id: 'p' + f })),
})
const KEYFAM = { frame_top: 'FT', frame_bottom: 'FB', frame_side: 'FS', sash_top: 'ST', sash_bottom: 'SB', key_stile: 'KS', hook_stile: 'HS' }
function owner() {
  const m = startModel('sliding_2')
  for (const [k, f] of Object.entries(KEYFAM)) m.lines[k][0].profile_family = f
  return m
}
const CASES = [
  ['partEditor-sliding2.html', () => startModel('sliding_2')],
  ['partEditor-sliding2-owner.html', owner],
]

describe('PartEditor golden (sliding_2, no add-on props)', () => {
  for (const [file, make] of CASES) {
    it(file, () => {
      const html = renderToString(
        <PartEditor model={make()} onChange={() => {}} index={index} canEdit testSeriesId="sA" testThicknessMm={1.5} onTestChange={() => {}} templateName="ทดสอบ" />,
      )
      const path = fileURLToPath(new URL(`./__fixtures__/${file}`, import.meta.url))
      if (process.env.UPDATE_GOLDEN) writeFileSync(path, html + '\n')
      expect(html + '\n').toBe(readFileSync(path, 'utf8'))
    })
  }
})

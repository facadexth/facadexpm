// @vitest-environment jsdom
// ProjectBomView wiring after a plan is issued: section 1's stock basis (issued lengths over the live plan's) and the
// length helper's edit gate. The hooks, the cut plan, the BOM roll-up and the child cards are stubbed to read props.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

const state = vi.hoisted(() => ({ plans: [], bomStock: [], props: {} }))
vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(n) }))
vi.mock('../../hooks/useEstimation2b.js', () => ({
  useProjectStock: () => ({ data: [], refetch: async () => {} }),
  useOffcuts: () => ({ data: [], refetch: async () => {} }),
  useCutPlans: () => ({ data: state.plans, refetch: async () => {} }),
  offcutsByGroup: () => ({}), issueCutPlan: async () => {}, voidCutPlan: async () => {},
}))
vi.mock('../../lib/cutPlan.js', async orig => ({ ...(await orig()), buildCutPlan: () => livePlan }))
vi.mock('../../lib/projectBom.js', async orig => ({
  ...(await orig()),
  buildProjectBom: ({ stock }) => { state.bomStock.push(stock); return { profiles: [], parts: [], unresolved: [], sealant: { length_m: 0, m_per_tube: 1, tubes: 0 } } },
}))
const stub = name => ({ default: p => { state.props[name] = p; return null } })
vi.mock('./BomProfilesTable.jsx', () => stub('BomProfilesTable'))
vi.mock('./CutOptimizerPanel.jsx', () => stub('CutOptimizerPanel'))
vi.mock('./CustomLengthSummary.jsx', () => stub('CustomLengthSummary'))
vi.mock('./CutModeField.jsx', () => stub('CutModeField'))
vi.mock('./CutSheetView.jsx', () => stub('CutSheetView'))
vi.mock('./StickerSheet.jsx', () => stub('StickerSheet'))
vi.mock('./OffcutStockPanel.jsx', () => stub('OffcutStockPanel'))
vi.mock('./ProviderCompare.jsx', () => stub('ProviderCompare'))

const { default: ProjectBomView } = await import('./ProjectBomView.jsx')
const { DEFAULT_SETTINGS } = await import('../../lib/estimationSettings.js')

const grp = (profile_id, length_m) => ({ key: `${profile_id}|f1`, profile_id, finish_id: 'f1', length_m, kg: 5, bars: [], newOffcuts: [], usedOffcuts: [] })
// Live plan: p1 on 6.40, p2 (added after issue) on its own custom length 5.85. Issued plan: p1 only, on 5.20.
const livePlan = { groups: [grp('p1', 6.4), grp('p2', 5.85)] }
const issuedRow = { id: 'cp1', project_id: 'pj', status: 'issued', plan: { groups: [grp('p1', 5.2)] } }
const index = { profiles: {}, finishes: {}, parts: {}, series: {}, providers: {}, variants: [], kgPrices: [], piecePrices: [] }
const view = () => render(<ProjectBomView project={{ id: 'pj', name: 'งาน', cut_mode: 'custom' }} items={[{ id: 'i1', opening_no: 'W-01', quantity: 1 }]}
  costs={{}} base={{}} index={index} seriesTypes={[]} settings={DEFAULT_SETTINGS} canEdit onProjectSaved={() => {}} />)

beforeEach(() => { state.plans = []; state.bomStock = []; state.props = {} })
afterEach(cleanup)

describe('ProjectBomView after issue', () => {
  it('section 1: a profile in the issued plan takes the issued length, one not in it keeps its live custom length (not 6.40)', () => {
    state.plans = [issuedRow]
    view()
    expect(state.bomStock.at(-1).byProfile).toEqual({ p1: 5.2, p2: 5.85 })
  })
  it('before issue, section 1 takes the live plan\'s lengths', () => {
    view()
    expect(state.bomStock.at(-1).byProfile).toEqual({ p1: 6.4, p2: 5.85 })
  })
  it('the length helper cannot save ("ใช้") once a plan is issued', () => {
    state.plans = [issuedRow]
    view()
    expect(state.props.CutOptimizerPanel.canEdit).toBe(false)
  })
  it('the length helper can save before issue', () => {
    view()
    expect(state.props.CutOptimizerPanel.canEdit).toBe(true)
  })
})

// src/lib/bomEngineAssembly.test.js -- Phase 2b engine seams: per-role thickness and the cut style carried to the cut optimizer.
import { describe, it, expect } from 'vitest'
import { computeBomForOpening } from './bomEngine.js'

// Tiny inline pricing stub: matches a profile by (family, series text, thickness) and costs it as kg x the colour price.
function stubPricing(profiles, finish) {
  return {
    kind: 'catalog',
    profileLine({ role_name, family, length_m, quantity, thickness_mm, opening }) {
      const profile = (profiles || []).find(p => p.family === family && p.series === opening.series && p.thickness_mm === thickness_mm) || null
      const resolved = !!profile
      const weight_kg = resolved ? length_m * quantity * profile.linear_weight_kg_per_m : 0
      const cost = resolved ? weight_kg * finish.price_per_kg : 0
      return { role_name, family, series: opening.series, thickness_mm, length_m, quantity, weight_kg, cost, resolved, reason: resolved ? null : 'no_profile', price_row_id: null }
    },
    hardwarePrice(h) { return { unit_price: h.reference_unit_price, source: 'reference', price_row_id: null } },
    setLines() { return [] },
  }
}


const P12 = { family: 'F', series: 'S', thickness_mm: 1.2, linear_weight_kg_per_m: 1 }
const P20 = { family: 'F', series: 'S', thickness_mm: 2, linear_weight_kg_per_m: 2 }
const FINISH = { price_per_kg: 100 }
const tpl = { waste_pct: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0, labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, grid_row_weights: [1] }
const opening = { width_m: 2, height_m: 1, panel_count: 1, series: 'S', thickness_mm: 1.2, quantity: 1, extra_lines: [] }
const comp = (o = {}) => ({ role_name: 'r', profile_family: 'F', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, ...o })
const run = components => computeBomForOpening(opening, tpl, components, [], stubPricing([P12, P20], FINISH), null)

describe('per-role thickness', () => {
  it('a component with its own thickness is priced from that profile; the others use the opening thickness', () => {
    const r = run([comp({ role_name: 'frame' }), comp({ role_name: 'sash', thickness_mm: 2 })])
    expect(r.profileLines[0].thickness_mm).toBe(1.2)
    expect(r.profileLines[0].cost).toBe(2 * 1 * 100)
    expect(r.profileLines[1].thickness_mm).toBe(2)
    expect(r.profileLines[1].cost).toBe(2 * 2 * 100)
  })
  it('a null component thickness means "use the opening thickness"', () => {
    expect(run([comp({ thickness_mm: null })]).profileLines[0].thickness_mm).toBe(1.2)
  })
  it('an override thickness with no matching profile is unresolved, not silently the opening thickness', () => {
    const r = run([comp({ thickness_mm: 3 })])
    expect(r.profileLines[0].resolved).toBe(false)
    expect(r.unresolvedComponents).toEqual(['r'])
  })
})

describe('cut style on profile lines', () => {
  it('defaults to square and carries the component cut_style (grid lines are square)', () => {
    const r = run([comp(), comp({ role_name: 'm', cut_style: 'miter45' })])
    expect(r.profileLines.map(l => l.cut_style)).toEqual(['square', 'miter45'])
  })
  it('grid members are square cuts', () => {
    const t = { ...tpl, grid_row_weights: [1, 1], grid_horizontal_rail_family: 'F' }
    expect(computeBomForOpening(opening, t, [], [], stubPricing([P12], FINISH), null).gridLines[0].cut_style).toBe('square')
  })
})

describe('hardware lines carry part_id', () => {
  it('part_id is passed through, null when absent', () => {
    const r = computeBomForOpening(opening, tpl, [], [{ name: 'a', part_id: 'p1', quantity_basis: 'fixed', quantity_value: 1 }, { name: 'b', quantity_basis: 'fixed', quantity_value: 1 }], stubPricing([P12], FINISH), null)
    expect(r.hardwareLines.map(l => l.part_id)).toEqual(['p1', null])
  })
})

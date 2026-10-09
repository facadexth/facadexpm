import { describe, it, expect } from 'vitest'
import { buildPriceInputs, projectFactors } from './priceStructureInputs.js'

const okCost = { bom: { profileLines: [{ cost: 100, weight_kg: 2 }] }, unresolved: [] }
const item = o => ({ id: 'a', quantity: 2, width_m: 1, height_m: 2, ...o })

describe('buildPriceInputs', () => {
  it('null/undefined cost -> unresolved with zero breakdown', () => {
    for (const c of [null, undefined]) {
      const [r] = buildPriceInputs({ items: [item()], costs: { a: c }, project: {} })
      expect(r.unresolved).toBe(true)
      expect(r.breakdown).toEqual({ alu: 0, hardware: 0, glass: 0, labour: 0, other: 0, aluWeightKg: 0 })
    }
  })
  it('missing key in costs map -> unresolved', () => {
    expect(buildPriceInputs({ items: [item()], costs: {}, project: {} })[0].unresolved).toBe(true)
  })
  it('non-empty cost.unresolved -> unresolved, empty -> resolved', () => {
    expect(buildPriceInputs({ items: [item()], costs: { a: { ...okCost, unresolved: ['x'] } } })[0].unresolved).toBe(true)
    const [r] = buildPriceInputs({ items: [item()], costs: { a: okCost } })
    expect(r.unresolved).toBe(false)
    expect(r.breakdown.alu).toBe(100)
  })
  it('zero or invalid size -> unresolved', () => {
    expect(buildPriceInputs({ items: [item({ width_m: 0 })], costs: { a: okCost } })[0].unresolved).toBe(true)
    expect(buildPriceInputs({ items: [item({ height_m: null })], costs: { a: okCost } })[0].unresolved).toBe(true)
  })
  it('profit: blank -> null, numeric string -> number, 0 stays 0', () => {
    const p = v => buildPriceInputs({ items: [item({ profit_pct: v })], costs: { a: okCost } })[0].profitPct
    expect(p('')).toBeNull(); expect(p('  ')).toBeNull(); expect(p(null)).toBeNull(); expect(p(undefined)).toBeNull()
    expect(p('20.5')).toBe(20.5); expect(p(0)).toBe(0); expect(p('0')).toBe(0)
  })
  it('extra costs coerced, quantity min 0, sizes numbers', () => {
    const [r] = buildPriceInputs({
      items: [item({ quantity: '-3', width_m: '1.5', height_m: '2', fire_barrier_cost: '10', bracket_cost: null, bend_alu_cost: '', bend_glass_cost: 4 })],
      costs: { a: okCost },
    })
    expect(r).toMatchObject({ id: 'a', quantity: 0, width_m: 1.5, height_m: 2, fireBarrier: 10, bracket: 0, bendAlu: 0, bendGlass: 4 })
  })
})

describe('projectFactors', () => {
  it('defaults', () => {
    for (const p of [null, undefined, {}, { round_step: null, waste_pct: null }]) {
      expect(projectFactors(p)).toEqual({ wastePct: 0, profitPct: 0, pmPct: 0, transportTotal: 0, roundStep: 100 })
    }
  })
  it('invalid step -> 100', () => {
    for (const s of [0, -5, 'abc', '']) expect(projectFactors({ round_step: s }).roundStep).toBe(100)
  })
  it('string numerics', () => {
    expect(projectFactors({ waste_pct: '5', profit_pct: '12.5', pm_pct: '3', transport_total: '1000', round_step: '50' }))
      .toEqual({ wastePct: 5, profitPct: 12.5, pmPct: 3, transportTotal: 1000, roundStep: 50 })
  })
})

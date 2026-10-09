import { describe, it, expect } from 'vitest'
import { costBreakdown, priceItem, priceProject, realProfitPct } from './priceStructure.js'

const bd = (alu, hardware = 0, glass = 0, labour = 0, other = 0, aluWeightKg = 0) => ({ alu, hardware, glass, labour, other, aluWeightKg })
const F = { wastePct: 10, profitPct: 45, pmPct: 2, transportTotal: 5000, roundStep: 100 }
const base = { quantity: 1, width_m: 1, height_m: 2, fireBarrier: 0, bracket: 0, bendAlu: 0, bendGlass: 0, profitPct: null, unresolved: false }

describe('costBreakdown', () => {
  it('splits an engine result and leaves the engine waste out', () => {
    const cost = {
      bom: { profileLines: [{ cost: 1000, weight_kg: 2 }], gridLines: [{ cost: 500, weight_kg: 1 }], hardwareLines: [{ cost: 300 }], hardwareSetLines: [{ cost: 200 }],
             infillCost: 700, laborCost: 400, siliconeCost: 20, feltCost: 10, extraLinesCost: 30, wasteCost: 150 },
      addonBom: { profileLines: [{ cost: 100, weight_kg: 0.5 }], gridLines: [], hardwareLines: [], hardwareSetLines: [], infillCost: 50, laborCost: 0, siliconeCost: 0, feltCost: 0, extraLinesCost: 0, wasteCost: 10 },
      extras: { cost: 40 },
    }
    expect(costBreakdown(cost)).toEqual({ alu: 1600, hardware: 500, glass: 750, labour: 400, other: 100, aluWeightKg: 3.5 })
  })
})

describe('priceItem', () => {
  it('V = all categories, W = alu x waste, X = V x profit, Y = V+W+X', () => {
    const r = priceItem({ breakdown: bd(3000, 1000, 1000, 500, 500), fireBarrier: 0, bracket: 0, bendAlu: 0, bendGlass: 0, profitPct: 45, wastePct: 10 })
    expect(r).toEqual({ v: 6000, w: 300, x: 2700, y: 9000 })
  })
  it('adds the four extra costs into V', () => {
    const r = priceItem({ breakdown: bd(1000), fireBarrier: 100, bracket: 200, bendAlu: 300, bendGlass: 400, profitPct: 0, wastePct: 0 })
    expect(r.v).toBe(2000)
  })
})

describe('priceProject', () => {
  it('single item: transport all on it, PM ceil, round up to step, per sqm', () => {
    const { rows, totals } = priceProject({ items: [{ ...base, id: 'a', breakdown: bd(3000, 1000, 1000, 500, 500, 10) }], factors: F })
    const r = rows[0]
    expect([r.v, r.w, r.x, r.y, r.z, r.pm]).toEqual([6000, 300, 2700, 9000, 5000, 180])
    expect(r.perSet).toBe(14180)
    expect(r.price).toBe(14200)
    expect(r.perSqm).toBe(14180 / 2)
    expect(r.lineTotal).toBe(14200)
    expect(totals.lineTotal).toBe(14200)
    expect(totals.aluWeightNet).toBe(10)
    expect(totals.aluWeightWithWaste).toBeCloseTo(11)
  })
  it('allocates transport by share of Y x quantity and divides by quantity', () => {
    const items = [
      { ...base, id: 'a', breakdown: bd(3000, 1000, 1000, 500, 500) },                 // Y 9000, qty 1
      { ...base, id: 'b', quantity: 2, breakdown: bd(1500, 500, 500, 250, 250) },     // Y 4500, qty 2
    ]
    const { rows } = priceProject({ items, factors: F })
    expect(rows[0].z).toBe(2500)
    expect(rows[1].z).toBe(1250)
    expect(rows[0].z * 1 + rows[1].z * 2).toBe(5000)
  })
  it('a per-item profit overrides the project (null = follow)', () => {
    const items = [{ ...base, id: 'a', profitPct: 20, breakdown: bd(3000, 1000, 1000, 500, 500) }]
    expect(priceProject({ items, factors: F }).rows[0].x).toBe(1200)
  })
  it('an unresolved item is flagged, priced as nothing, and excluded from the transport share and totals', () => {
    const items = [{ ...base, id: 'a', breakdown: bd(3000, 1000, 1000, 500, 500) }, { ...base, id: 'u', unresolved: true, breakdown: bd(0) }]
    const { rows, totals } = priceProject({ items, factors: F })
    expect(rows[1].resolved).toBe(false)
    expect(rows[1].price).toBe(null)
    expect(rows[0].z).toBe(5000)
    expect(totals.lineTotal).toBe(14200)
  })
  it('never yields NaN or Infinity with no items, zero size or zero V', () => {
    expect(priceProject({ items: [], factors: F }).totals.lineTotal).toBe(0)
    const r = priceProject({ items: [{ ...base, id: 'z', width_m: 0, height_m: 0, breakdown: bd(0) }], factors: F }).rows[0]
    for (const k of ['v', 'w', 'x', 'y', 'z', 'pm', 'perSet']) expect(Number.isFinite(r[k])).toBe(true)
    expect(r.perSqm).toBe(null)
  })
  it('treats a missing factor as 0 and a missing/invalid step as 100', () => {
    const { rows } = priceProject({ items: [{ ...base, id: 'a', breakdown: bd(1000) }], factors: { roundStep: 0 } })
    expect(rows[0].price).toBe(1000)
  })
})

describe('realProfitPct', () => {
  it('(agreed net - (V+W+Z+PM)) / V', () => {
    expect(realProfitPct({ v: 6000, w: 300, z: 5000, pm: 180, agreedNet: 14200 })).toBeCloseTo(45.333, 2)
    expect(realProfitPct({ v: 6000, w: 300, z: 5000, pm: 180, agreedNet: 13000 })).toBeCloseTo(25.333, 2)
  })
  it('is null when V is 0', () => {
    expect(realProfitPct({ v: 0, w: 0, z: 0, pm: 0, agreedNet: 100 })).toBe(null)
  })
})

describe('ELSY workbook validation', () => {
  it('matches ELSY row 7 (D1) - per-item calculations', () => {
    // ELSY sheet D1: width=5.45m, height=2.7m, qty=2, sheet V=23852.925, W=0, X=10733.81625, Y=34586.74125
    // Breakdown cost values from sheet: glass=11870, labour=11772, other=210.925 (to match V total)
    const bd_d1 = { alu: 0, hardware: 0, glass: 11870, labour: 11772, other: 210.925, aluWeightKg: 0 }
    const r = priceItem({ breakdown: bd_d1, fireBarrier: 0, bracket: 0, bendAlu: 0, bendGlass: 0, profitPct: 45, wastePct: 10 })
    expect(r.v).toBe(23852.925)
    expect(r.w).toBe(0) // no alu, so no waste
    expect(r.x).toBeCloseTo(10733.81625, 4)
    expect(r.y).toBeCloseTo(34586.74125, 4)
  })
  it('matches ELSY row 8 (D2) - per-item calculations', () => {
    // ELSY sheet D2: width=7.45m, height=2.7m, qty=2, sheet V=32609.925, W=0, X=14674.46625
    // Breakdown: glass=16230, labour=16092, other=287.925
    const bd_d2 = { alu: 0, hardware: 0, glass: 16230, labour: 16092, other: 287.925, aluWeightKg: 0 }
    const r = priceItem({ breakdown: bd_d2, fireBarrier: 0, bracket: 0, bendAlu: 0, bendGlass: 0, profitPct: 45, wastePct: 10 })
    expect(r.v).toBe(32609.925)
    expect(r.w).toBe(0)
    expect(r.x).toBeCloseTo(14674.46625, 4)
    expect(r.y).toBeCloseTo(47284.39125, 4)
  })
  it('matches ELSY row 9 (D3) - per-item calculations', () => {
    // ELSY sheet D3: width=2.3m, height=2.7m, qty=1, sheet V=10066.95, W=0, X=4530.1275
    // Breakdown: glass=5010, labour=4968, other=88.95
    const bd_d3 = { alu: 0, hardware: 0, glass: 5010, labour: 4968, other: 88.95, aluWeightKg: 0 }
    const r = priceItem({ breakdown: bd_d3, fireBarrier: 0, bracket: 0, bendAlu: 0, bendGlass: 0, profitPct: 45, wastePct: 10 })
    expect(r.v).toBe(10066.95)
    expect(r.w).toBe(0)
    expect(r.x).toBeCloseTo(4530.1275, 4)
    expect(r.y).toBeCloseTo(14597.0775, 4)
  })
})

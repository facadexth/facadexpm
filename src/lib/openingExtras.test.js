import { describe, it, expect } from 'vitest'
import { mergeSettings } from './estimationSettings.js'
import { fixingPointsForSide, frameFixingPoints, sealantTubes, openingExtras } from './openingExtras.js'

const S = mergeSettings(null)
const pricing = { hardwarePrice: h => (h.part_id === 'shim' ? { unit_price: 2, source: 'part' } : { unit_price: 0, source: 'reference' }) }

describe('fixing points', () => {
  it('every 60 cm, at least 2 per side (the mockup table: 2.40->5, 2.10->5, 1.20->3, 1.00->3, 0.40->2)', () => {
    const f = l => fixingPointsForSide(l, 0.6, 2)
    expect([f(2.4), f(2.1), f(1.2), f(1.0), f(0.4)]).toEqual([5, 5, 3, 3, 2])
  })
  it('a side of 0 / negative / NaN has no points; a very short side still gets the minimum', () => {
    expect([fixingPointsForSide(0, 0.6, 2), fixingPointsForSide(-1, 0.6, 2), fixingPointsForSide(NaN, 0.6, 2)]).toEqual([0, 0, 0])
    expect(fixingPointsForSide(0.1, 0.6, 2)).toBe(2)
  })
  it('a frame totals 2 x width side + 2 x height side (D-01 2.40 x 2.10 = 20)', () => {
    expect(frameFixingPoints(2.4, 2.1, S)).toBe(20)
    expect(frameFixingPoints(1.2, 1.0, S)).toBe(12)
  })
})

describe('sealantTubes', () => {
  it('rounds the project total up once (14 m at 10 m per tube = 2)', () => {
    expect(sealantTubes(14, 10)).toBe(2)
    expect(sealantTubes(10, 10)).toBe(1)
    expect(sealantTubes(0, 10)).toBe(0)
  })
})

describe('openingExtras', () => {
  const parts = { shim: { name: 'shim', unit: 'ตัว' }, screw: { name: 'สกรู', unit: 'ตัว' } }
  it('does nothing until parts are linked', () => {
    const r = openingExtras({ units: [{ width_m: 2.4, height_m: 2.1 }], settings: S, partsById: parts, pricing })
    expect(r.lines).toEqual([])
    expect(r.points).toBe(20)
    expect(r.sealant_m).toBeCloseTo(9, 9)
    expect(r.cost).toBe(0)
  })
  it('prices a linked part and lists an unpriced one instead of using 0 silently', () => {
    const r = openingExtras({ units: [{ width_m: 2.4, height_m: 2.1 }], settings: { ...S, shim_part_id: 'shim', screw_part_id: 'screw' }, partsById: parts, pricing })
    expect(r.lines.map(l => [l.key, l.quantity, l.cost, l.resolved])).toEqual([['shim', 20, 40, true], ['screw', 20, 0, false]])
    expect(r.cost).toBe(40)
    expect(r.unresolved).toEqual([{ name: 'สกรู', reason: 'no_part_price' }])
  })
  it('the add-on is its own frame: points and sealant add up; an invalid unit is ignored', () => {
    const r = openingExtras({ units: [{ width_m: 1.2, height_m: 1.0 }, { width_m: 1.2, height_m: 0.4 }, { width_m: 0, height_m: 1 }], settings: S, partsById: parts, pricing })
    expect(r.points).toBe(12 + 2 * 3 + 2 * 2)
    expect(r.sealant_m).toBeCloseTo(2 * 2.2 + 2 * 1.6, 9)
  })
})

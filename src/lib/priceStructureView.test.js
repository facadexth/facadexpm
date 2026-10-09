import { describe, it, expect } from 'vitest'
import { visibleColumns, sumproductRow, costPieData, pricePieData, glassHover, weightSummary, columnValue, COLUMN_LABELS, PRICE_LABELS } from './priceStructureView'

const row = (o = {}) => ({
  id: 'a', quantity: 1, resolved: true, v: 0, w: 0, x: 0, y: 0, z: 0, pm: 0, lineTotal: 0,
  breakdown: { alu: 0, hardware: 0, glass: 0, labour: 0, other: 0 },
  extraCosts: { fireBarrier: 0, bracket: 0, bendAlu: 0, bendGlass: 0 }, ...o,
})
const withB = (b, e = {}, o = {}) => row({ breakdown: { alu: 0, hardware: 0, glass: 0, labour: 0, other: 0, ...b }, extraCosts: { fireBarrier: 0, bracket: 0, bendAlu: 0, bendGlass: 0, ...e }, ...o })

describe('priceStructureView', () => {
  it('hides all-zero columns, shows non-zero', () => {
    expect(visibleColumns([withB({ alu: 10 }), withB({ glass: 5 })])).toEqual(['alu', 'glass'])
    expect(visibleColumns([withB({}, { fireBarrier: 100 })])).toContain('fireBarrier')
    expect(visibleColumns([withB({ alu: 10 }, {})])).not.toContain('fireBarrier')
  })
  it('ignores unresolved rows for visibility and sums', () => {
    const un = withB({ hardware: 99 }, {}, { resolved: false })
    expect(visibleColumns([withB({ alu: 1 }), un])).toEqual(['alu'])
    expect(sumproductRow([un], ['alu']).hardware).toBe(0)
  })
  it('sumproduct multiplies by quantity', () => {
    const r = withB({ alu: 10 }, { bracket: 3 }, { quantity: 2, v: 13, lineTotal: 40 })
    const s = sumproductRow([r], ['alu', 'bracket'])
    expect(s.alu).toBe(20); expect(s.bracket).toBe(6); expect(s.v).toBe(26); expect(s.lineTotal).toBe(40) /* row.lineTotal already includes qty */
    expect(s.hardware).toBe(0)
  })
  it('costPieData drops zeros and sums to sumproduct', () => {
    const rows = [withB({ alu: 10, glass: 5 }, { fireBarrier: 2 }, { quantity: 2 })]
    const pie = costPieData(rows)
    expect(pie.map(p => p.key)).toEqual(['alu', 'glass', 'fireBarrier'])
    expect(pie[0].label).toBe('อลูมิเนียม')
    const sp = sumproductRow(rows, visibleColumns(rows))
    expect(pie.reduce((s, p) => s + p.value, 0)).toBe(sp.alu + sp.glass + sp.fireBarrier)
  })
  it('pricePieData drops zeros', () => {
    const p = pricePieData({ sumV: 100, sumW: 0, sumX: 20, sumZ: 5, sumPm: 0 })
    expect(p.map(x => x.key)).toEqual(['v', 'x', 'z'])
    expect(p[0].label).toBe('รวมต้นทุน')
  })
  it('glassHover', () => {
    expect(glassHover({ code: 'TP6', name: 'กระจกเทมเปอร์ 6', price_per_sqm: 1000 })).toEqual({ code: 'TP6', name: 'กระจกเทมเปอร์ 6', perSqm: 1000, perSqft: 92.9 })
    expect(glassHover(null)).toBeNull()
    expect(glassHover({ name: 'x', price_per_sqm: '500' }).code).toBe('')
  })
  it('weightSummary rounds', () => {
    expect(weightSummary({ aluWeightNet: 10.456, aluWeightWithWaste: 11.5019 })).toEqual({ net: 10.46, withWaste: 11.5 })
  })
  it('labels and columnValue', () => {
    expect(COLUMN_LABELS.bendGlass).toBe('ดัดโค้ง กระจก')
    expect(PRICE_LABELS.pm).toBe('PM')
    expect(columnValue(withB({ other: 4 }), 'other')).toBe(4)
  })
  it('empty input has no NaN', () => {
    const out = JSON.stringify([visibleColumns([]), sumproductRow([], []), costPieData([]), pricePieData({}), weightSummary({}), pricePieData(undefined), weightSummary(undefined)])
    expect(out).not.toMatch(/NaN|null/)
    expect(sumproductRow([], []).lineTotal).toBe(0)
  })
})

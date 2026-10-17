import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildImport, renderSql, renderReport, expectedCounts, expandRow, midpoint } from './catalogue-import-lib.mjs'
import { CONFIGS, loadInputs } from './catalogue-import-configs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const prof = (die, extra = {}) => ({ die_no: die, name: 'n' + die, role_family: 'เฟรมบน', kg_per_m: 1, width_mm: 101.6, depth_mm: 47, wall_mm: 1.2, page: 1, confidence: 'read', ...extra })
const cfgOf = (n) => ({ id: 't', provider: { name: 'P', short_name: 'P', price_basis: 'per_kg' }, prefix: '_t_', decision: '', sqlFile: 'x', reportFile: 'y', dryrun: 'z',
  sources: [{ label: 'L', file: 'f', series: Array.from({ length: n }, (_, i) => ({ idx: i, name: 'S' + i, types: ['T' + i] })) }], finishes: [] })
const inputOf = (series) => ({ f: { series: series.map((profiles, i) => ({ name: 'S' + i, profiles })) } })

describe('midpoint', () => {
  it('reads "a-b", [a, b] and plain numbers; anything else is null', () => {
    expect(midpoint('3.9-4.2')).toBeCloseTo(4.05)
    expect(midpoint([3, 3.3])).toBeCloseTo(3.15)
    expect(midpoint('4.0')).toBe(4)
    expect(midpoint(null)).toBeNull()
    expect(midpoint('ca. 4')).toBeNull()
  })
})

describe('expandRow', () => {
  it('one item per plain-number thickness from a kg/bar table; grades like "1.2 Over" are skipped with a reason', () => {
    const r = expandRow(prof('4001', { std_length_m: 6.4, kg_per_m: 0.6, confidence: 'estimated', weights_by_thickness: [
      { thickness_mm: '1.0', anodize_kg_per_bar: '3.9-4.2' }, { thickness_mm: '1.2 Over', anodize_kg_per_bar: '4.4-4.7' }, { thickness_mm: '1.5', anodize_kg_per_bar: null }] }))
    expect(r.items).toEqual([{ thickness_mm: 1, kg: 0.633, kgNote: 'กลางช่วง 3.9-4.2 กก./เส้น ÷ 6.4 ม.' }])
    expect(r.skipped).toEqual(['ความหนา "1.2 Over" ไม่ใช่ตัวเลข', '1.5 มม.: ไม่มีน้ำหนักสีชุบ'])
  })
  it('accepts an estimated kg/m only when it is a midpoint of a printed range (owner C3)', () => {
    expect(expandRow(prof('A', { confidence: 'estimated', kg_per_m_basis: 'midpoint of anodize kg/bar ÷ 6.4 m' })).items).toHaveLength(1)
    expect(expandRow(prof('A', { confidence: 'estimated' })).skipped).toEqual(['confidence "estimated"'])
  })
  it('a kg-per-bar range without a bar length yields nothing (SMS retail, owner question SM1)', () => {
    expect(expandRow(prof('S1', { kg_per_m: null, kg_per_piece_range: [3, 3.3] })).skipped[0]).toMatch(/ไม่บอกความยาวเส้น/)
  })
})

describe('buildImport', () => {
  it('one profile per die x thickness, linked to each series; a printing without kg/m links to the weighed one', () => {
    const m = buildImport(cfgOf(2), inputOf([[prof('D', { wall_mm: 1.2 }), prof('D', { wall_mm: 1.5, kg_per_m: 1.4 })], [prof('D', { wall_mm: 1.2, kg_per_m: null })]]))
    expect(m.profiles.map(p => p.key)).toEqual(['D|1.2', 'D|1.5'])
    expect(m.links.map(l => `${l.series}:${l.key}`)).toEqual(['S0:D|1.2', 'S0:D|1.5', 'S1:D|1.2'])
    expect(m.reprints).toEqual([expect.objectContaining({ die: 'D', field: 'kg', other: 'ไม่ได้พิมพ์' })])
    expect(m.profiles.every(p => p.default_length_m === 6.4)).toBe(true)
    expect(m.assumedLength).toBe(2)
  })
  it('links a series to its types only when none of its dies is missing', () => {
    const m = buildImport(cfgOf(2), inputOf([[prof('A')], [prof('B'), prof('C', { kg_per_m: null })]]))
    expect(m.typeLinks).toEqual([{ series: 'S0', type_name: 'T0' }])
    expect(m.incomplete).toEqual([{ name: 'S1', types: ['T1'], missing: 1 }])
  })
  it('skips mapped groups, drops empty series, refuses a mapping that does not match the catalogue', () => {
    const cfg = cfgOf(2); cfg.sources[0].series[1] = { idx: 1, skip: 'dup' }
    const m = buildImport(cfg, inputOf([[prof('A', { kg_per_m: null })], [prof('B')]]))
    expect(m.series).toEqual([])
    expect(m.excluded.map(x => x.reason)).toEqual(['กลุ่มนี้ไม่นำเข้า: dup', 'ไม่มี กก./ม.'])
    expect(() => buildImport(cfgOf(3), inputOf([[], []]))).toThrow(/mapping/)
  })
})

describe('real inputs', () => {
  const want = {
    sp: { providers: 1, series: 5, profiles: 96, series_profiles: 109, finishes: 5, series_types: 17 },
    alumet: { providers: 1, series: 15, profiles: 351, series_profiles: 366, finishes: 25, series_types: 19 },
    sms: { providers: 1, series: 17, profiles: 1634, series_profiles: 1642, finishes: 4, series_types: 13 },
  }
  for (const cfg of CONFIGS) {
    it(`${cfg.id}: the committed SQL and report are what the generator produces, with the expected counts`, () => {
      const m = buildImport(cfg, loadInputs(cfg))
      expect(expectedCounts(m)).toEqual(want[cfg.id])
      const sql = renderSql(m)
      expect(fs.readFileSync(path.join(root, cfg.sqlFile), 'utf8')).toBe(sql)
      expect(fs.readFileSync(path.join(root, cfg.reportFile), 'utf8')).toBe(renderReport(m))
      expect(sql).not.toMatch(/alu_piece_prices|alu_profile_variants/)
      expect(sql).toContain(`e_profiles      CONSTANT INT := ${want[cfg.id].profiles};`)
    })
  }
})

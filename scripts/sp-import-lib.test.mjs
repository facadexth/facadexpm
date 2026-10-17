import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildImport, renderSql, renderReport, expectedCounts, CATALOGUE_SERIES } from './sp-import-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))

const prof = (die, extra = {}) => ({ die_no: die, name: 'n' + die, role_family: 'เฟรมบน 2 ราง', kg_per_m: 1, width_mm: 101.6, depth_mm: 47, wall_mm: 1.2, page: 1, confidence: 'read', ...extra })
const fixture = () => ({
  finishes: [{ name: 'Standard White' }, { name: 'Champagne' }],
  series: CATALOGUE_SERIES.map((_, i) => ({ name: 'S' + i, profiles: [] })),
})

describe('SMART PLUS buildImport', () => {
  it('makes one profile per die, linked to every series that prints it, first printing with a kg/m kept', () => {
    const c = fixture()
    c.series[2].profiles.push(prof('15148', { kg_per_m: 0.148, page: 34 }))
    c.series[3].profiles.push(prof('15148', { kg_per_m: null, page: 47 }))
    c.series[0].profiles.push(prof('15100'))
    const m = buildImport({ catalog: c, cuts: null })
    expect(m.profiles.map(p => p.die)).toEqual(['15100', '15148'])
    expect(m.profiles[1].kg).toBe(0.148)
    expect(m.links.filter(l => l.key === '15148').map(l => l.series).sort()).toEqual([CATALOGUE_SERIES[2].name, CATALOGUE_SERIES[3].name].sort())
    expect(m.reprints).toEqual([expect.objectContaining({ die: '15148', field: 'kg', other: 'ไม่ได้พิมพ์', page: 47 })])
    expect(m.profiles.every(p => p.default_length_m === 6.4)).toBe(true)
  })

  it('excludes a die that has no kg/m anywhere, and reports differing reprints', () => {
    const c = fixture()
    c.series[0].profiles.push(prof('15999', { kg_per_m: null }))
    c.series[0].profiles.push(prof('15115', { kg_per_m: 0.267 }))
    c.series[1].profiles.push(prof('15115', { kg_per_m: 0.271, page: 8 }))
    const m = buildImport({ catalog: c, cuts: null })
    expect(m.excludedProfiles.map(x => [x.die, x.reason])).toEqual([['15999', 'no kg/m']])
    expect(m.reprints).toEqual([expect.objectContaining({ die: '15115', field: 'kg', kept: 0.267, other: 0.271 })])
  })

  it('refuses a catalogue whose series count does not match the mapping', () => {
    const c = fixture(); c.series.pop()
    expect(() => buildImport({ catalog: c, cuts: null })).toThrow(/mapping/)
  })

  it('lists cut-sheet dies that are not in the catalogue', () => {
    const c = fixture(); c.series[4].profiles.push(prof('15171'))
    const cuts = { series: [{ name: 'F', assembly: [{ type: 't', page: 16, cut_formulas: [{ die_no: '15171', member: 'เสา', formula_as_printed: 'H - 0' }, { die_no: '15181', member: 'x', formula_as_printed: 'W' }] }] }] }
    const m = buildImport({ catalog: c, cuts })
    expect(m.cutMissingDies).toEqual(['15181'])
    expect(m.totals.formulas).toBe(2)
  })
})

describe('SMART PLUS real inputs', () => {
  const m = buildImport({ catalog: read('docs/catalogs/smartplus/smart-plus-2024.json'), cuts: read('docs/catalogs/smartplus/smart-plus-cut-formulas-2022.json') })
  it('the committed SQL and report are what the generator produces from the committed JSON', () => {
    expect(fs.readFileSync(path.join(root, 'supabase/datafix/2026-10-17-import-smartplus-catalogue.sql'), 'utf8')).toBe(renderSql(m))
    expect(fs.readFileSync(path.join(root, 'docs/catalogs/smartplus/IMPORT-REPORT.md'), 'utf8')).toBe(renderReport(m))
  })
  it('imports every catalogue die, with the counts the SQL guards carry', () => {
    expect(expectedCounts(m)).toEqual({ providers: 1, series: 5, profiles: 96, series_profiles: 109, finishes: 5, series_types: 17 })
    expect(m.excludedProfiles).toEqual([])
    const sql = renderSql(m)
    expect(sql).toContain('e_profiles      CONSTANT INT := 96;')
    expect(sql).not.toMatch(/alu_piece_prices|alu_profile_variants/)
  })
})

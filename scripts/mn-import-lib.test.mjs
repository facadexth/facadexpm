import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normDie, parseThickness, normFinish, pickDefaultLength, q, roleVerdict,
  buildImport, expectedCounts, renderSql, CATALOGUE_SERIES, SYSTEM_SERIES,
} from './mn-import-lib.mjs'

describe('normDie', () => {
  it('drops the MN- / "MN " prefix, upper-cases and removes inner spaces', () => {
    expect(normDie('MN-U2515')).toBe('U2515')
    expect(normDie('MN U2515')).toBe('U2515')
    expect(normDie(' mn-m30082 ')).toBe('M30082')
    expect(normDie('U41 73B')).toBe('U4173B')
    expect(normDie('TS14805-1')).toBe('TS14805-1')
  })
  it('does not guess: "MN30435" keeps its letters, empty is null', () => {
    expect(normDie('MN30435')).toBe('MN30435')
    expect(normDie('')).toBeNull()
    expect(normDie(null)).toBeNull()
    expect(normDie('   ')).toBeNull()
  })
})

describe('parseThickness', () => {
  it('accepts numbers and plain decimal text, null when not printed', () => {
    expect(parseThickness(1.5)).toEqual({ ok: true, value: 1.5 })
    expect(parseThickness('2.0')).toEqual({ ok: true, value: 2 })
    expect(parseThickness(null)).toEqual({ ok: true, value: null })
  })
  it('rejects Mill, fractions and non-positive values', () => {
    expect(parseThickness('Mill').ok).toBe(false)
    expect(parseThickness('mill').ok).toBe(false)
    expect(parseThickness('5/8"').ok).toBe(false)
    expect(parseThickness(0).ok).toBe(false)
  })
})

describe('normFinish', () => {
  it('keeps printed names, drops N/A', () => {
    expect(normFinish(' ชาดำ ')).toBe('ชาดำ')
    expect(normFinish('N/A')).toBeNull()
    expect(normFinish('na')).toBeNull()
    expect(normFinish(null)).toBeNull()
  })
})

describe('pickDefaultLength', () => {
  it('takes the most common printed length', () => {
    expect(pickDefaultLength([6, 6, 6.4])).toEqual({ length_m: 6, assumed: false })
  })
  it('breaks a tie towards 6.4, then the longer bar', () => {
    expect(pickDefaultLength([6, 6.4])).toEqual({ length_m: 6.4, assumed: false })
    expect(pickDefaultLength([6, 6.1])).toEqual({ length_m: 6.1, assumed: false })
  })
  it('falls back to 6.4 and says it was assumed', () => {
    expect(pickDefaultLength([])).toEqual({ length_m: 6.4, assumed: true })
    expect(pickDefaultLength([null])).toEqual({ length_m: 6.4, assumed: true })
  })
})

describe('q', () => {
  it('quotes SQL literals', () => {
    expect(q(null)).toBe('NULL')
    expect(q(1.25)).toBe('1.25')
    expect(q("Z' 3/4")).toBe("'Z'' 3/4'")
    expect(q('กล่อง 4"')).toBe(`'กล่อง 4"'`)
    expect(() => q(NaN)).toThrow()
  })
})

describe('roleVerdict', () => {
  it('same / compatible / conflict', () => {
    expect(roleVerdict('เสากุญแจ', 'เสากุญแจ')).toBe('same')
    expect(roleVerdict('ขวางบน/ขวางล่าง', 'ขวางล่าง')).toBe('compatible')
    expect(roleVerdict('กรอบบานยูโร', 'กรอบบาน')).toBe('compatible')
    expect(roleVerdict('เฟรมยูโร 2 ราง', 'เฟรมบน 2 ราง')).toBe('compatible')
    expect(roleVerdict('รางล่าง', null)).toBe('compatible')
    expect(roleVerdict('เสากุญแจ', 'เสาเกี่ยว')).toBe('conflict')
    expect(roleVerdict('ตัวเสริมเสาเกี่ยว', 'เสาเกี่ยว')).toBe('conflict')
  })
})

// a tiny fixture: 2 catalogue groups, one guide system, a price book with every exclusion case
function fixture() {
  const prof = (die, role, wall, kg, extra = {}) => ({ die_no: die, name: `n ${die}`, role_family: role, kg_per_m: kg, width_mm: 50, depth_mm: 20, wall_mm: wall, std_length_m: null, page: 1, confidence: 'read', ...extra })
  const groups = Array.from({ length: 42 }, () => ({ name: 'g', profiles: [] }))
  groups[18] = { name: 'SLIDING 95', profiles: [prof('M4001', 'เฟรมบน 2 ราง', 1.2, 0.8), prof('M4002', 'เฟรมล่าง 2 ราง', 1.2, 0.9), prof('M4011', 'เสาเกี่ยว', 1.2, 0.5)] }
  groups[1] = { name: 'SHOPFRONT', profiles: [prof('U1598', 'กล่องเรียบ', 1.2, 0.72), prof('U2980', 'ฝาปิด', 1.2, 1.541, { note: 'likely a catalogue misprint' }), prof('M3064', 'ธรณี', 2, 1.1, { note: 'kg/m read; role (family) is a guess from the shape' }), prof(null, 'ท่อเหลี่ยม', 1, 0.2)] }
  const catalog = { series: groups }
  const row = (die, finish, th, price, extra = {}) => ({ die_no: die, item: die ? null : 'กล่องร่อง', finish, thickness_mm: th, price, unit: 'บาท/เส้น', length_m: 6.4, page: 3, confidence: 'read', ...extra })
  const pricebook = { series: [
    { name: 'ชุดบานเลื่อน', prices: [
      row('MN-M4001', 'ขาว', 1.2, 500), row('M4001', 'ขาว', 1.2, 500, { page: 9 }), // same price twice -> one price
      row('MN-M4002', 'ขาว', 1.2, 600), row('MN-M4002', 'ขาว', null, 650), // conflict -> both out
      row('MN-M4011', 'ชาดำ', 1.5, 700), // thickness conflict
      row('MN-U1598', 'N/A', 1.2, 100), // N/A finish
      row('MN-U1598', 'ลายไม้', 'Mill', 100), // thickness text
      row('MN-U1598', 'สีพ่น', 1.2, 300, { length_m: null }), // no length
      row('MN-U1598', 'ชาดำ', 1.2, 320, { confidence: 'estimated' }),
      row('MN-U1598', 'ชาดำ', 1.2, 330, { length_m: 6 }),
      row('MN-U2980', 'ขาว', 1.2, 99), // profile excluded
      row('MN-X9999', 'ขาว', 1.2, 99), // not in catalogue
      row(null, 'ขาว', 1, 1100), // label only
    ] },
  ] }
  const sets = {}
  for (const s of SYSTEM_SERIES) {
    sets[s.file] = sets[s.file] || { series: [] }
    sets[s.file].series[s.idx] = { name: s.name, profiles: [] }
  }
  sets.mn01.series[0].profiles = [
    { die_no: 'MN-M4001', role_family: 'เฟรมบน 2 ราง', page: 4 },
    { die_no: 'MN-M4011', role_family: 'เสากุญแจ', page: 4 }, // conflicts with catalogue เสาเกี่ยว
  ]
  sets.mn06.series[0].profiles = [{ die_no: 'MN-M4002', role_family: 'เฟรมล่าง 2 ราง', page: 4 }] // complete -> type link
  return { catalog, pricebook, sets }
}

describe('buildImport', () => {
  const m = buildImport({ ...fixture(), kgOverrides: {} })
  const reasons = m.priceExcl.map(x => x.reason)
  it('imports catalogue profiles except the misprint, nulls guessed roles, keys no-die rows by name + thickness', () => {
    expect(m.profiles.map(p => p.key)).toEqual(['M3064', 'M4001', 'M4002', 'M4011', 'NODIE|n null|1', 'U1598'].sort())
    expect(m.excludedProfiles.map(x => x.die)).toEqual(['U2980'])
    expect(m.profiles.find(p => p.key === 'M3064').family).toBeNull()
  })
  it('dedupes identical prices and excludes every conflicting or unclear cell with a reason', () => {
    expect(m.prices).toEqual([
      { key: 'M4001', finish: 'ขาว', length_m: 6.4, price: 500, page: 3, dupCells: 2 },
      { key: 'U1598', finish: 'ชาดำ', length_m: 6, price: 330, page: 3, dupCells: 1 },
    ])
    expect(m.priceConflicts).toHaveLength(1)
    expect(reasons.filter(r => r.startsWith('ราคาขัดกัน'))).toHaveLength(2)
    expect(reasons).toContain('ความหนาขัดกัน: ใบราคา 1.5 / แคตตาล็อก 1.2')
    expect(reasons).toContain('สีผิว N/A')
    expect(reasons).toContain('ความหนาไม่ใช่ตัวเลข ("Mill")')
    expect(reasons).toContain('ไม่ได้พิมพ์ความยาวเส้น')
    expect(reasons).toContain('estimated (OCR อ่านไม่ชัด)')
    expect(reasons).toContain('หน้าตัดถูกตัดออก (kg/m น่าจะพิมพ์ผิด)')
    expect(reasons).toContain('die ไม่มีในแคตตาล็อก 2021 (ไม่มี กก./ม.)')
    expect(reasons).toContain('ไม่มีเลข die (มีแต่ชื่อรายการ)')
    expect(m.prices.reduce((n, x) => n + x.dupCells, 0) + m.priceExcl.length).toBe(fixture().pricebook.series[0].prices.length) // every cell accounted for
  })
  it('sets default_length_m from the printed length, else 6.4 assumed', () => {
    expect(m.profiles.find(p => p.key === 'U1598').default_length_m).toBe(6)
    expect(m.profiles.find(p => p.key === 'M4011').default_length_m).toBe(6.4)
    expect(m.finishes).toEqual(['ขาว', 'ชาดำ'])
  })
  it('links systems only with compatible roles and type-links only complete systems', () => {
    const sys = SYSTEM_SERIES[0].name
    expect(m.links.filter(l => l.series === sys).map(l => l.key)).toEqual(['M4001'])
    expect(m.setSkipped.map(x => x.die)).toEqual(['M4011'])
    expect(m.typeLinks.some(t => t.series === sys)).toBe(false)
    expect(m.typeLinks).toContainEqual({ series: 'ชุดบานกระทุ้ง UNION (UN)', type_name: 'บานกระทุ้ง' })
    expect(m.typeLinks).toContainEqual({ series: CATALOGUE_SERIES[18].name, type_name: 'บานเลื่อนสวน 2 บาน' })
  })
  it('renders SQL whose guards carry the expected counts, deterministically', () => {
    const e = expectedCounts(m)
    const sql = renderSql(m)
    expect(sql).toContain(`e_profiles      CONSTANT INT := ${e.profiles};`)
    expect(sql).toContain(`e_prices        CONSTANT INT := ${e.piece_prices};`)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(sql).not.toMatch(/butt_distance_mm\s*[,)]/) // never written
    expect(renderSql(buildImport({ ...fixture(), kgOverrides: {} }))).toBe(sql)
  })
})

describe('real inputs', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
  it('the committed SQL is what the generator produces from the committed JSON', () => {
    const sets = {}
    for (const f of fs.readdirSync(path.join(root, 'docs/catalogs/mn-sets')).filter(f => /^mn\d\d-.*\.json$/.test(f)).sort()) sets[f.slice(0, 4)] = read(`docs/catalogs/mn-sets/${f}`)
    const m = buildImport({ catalog: read('docs/catalogs/mn/mn-aluminium-profile-2021.json'), pricebook: read('docs/catalogs/sms/mn-pricelist-2024.json'), sets })
    const committed = fs.readFileSync(path.join(root, 'supabase/datafix/2026-10-17-import-mn-catalogue.sql'), 'utf8')
    expect(committed).toBe(renderSql(m))
    expect(m.prices.every(p => p.price >= 0 && p.length_m > 0)).toBe(true)
    expect(m.profiles.every(p => p.kg >= 0 && p.default_length_m > 0 && (p.thickness_mm === null || p.thickness_mm > 0))).toBe(true)
  })
})

describe('owner kg/m overrides', () => {
  it('imports a misprinted die with the owner value instead of excluding it (MN3: U2980 = 0.54)', () => {
    const m = buildImport(fixture())
    expect(m.excludedProfiles.map(x => x.die)).toEqual([])
    expect(m.profiles.find(p => p.key === 'U2980').kg).toBe(0.54)
    expect(m.kgOverridden).toEqual([{ die: 'U2980', name: 'n U2980', printed: 1.541, used: 0.54 }])
  })
})

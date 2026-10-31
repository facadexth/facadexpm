// src/lib/migrationFiles20261031.test.js
// Guard for the 2026-10-31 migrations: the SQL runner refuses any text containing DELETE / DROP / TRUNCATE, and each
// dry run must replay its migration verbatim between BEGIN and ROLLBACK (so the dry run tests the real text).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const MIGRATIONS = ['2026-10-31-01-alu-series-family', '2026-10-31-02-alu-parts-stock-link']
const REPORTS = ['2026-10-31-series-family-price-report', '2026-10-31-hardware-stock-match-report']
const mig = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8')
const dry = name => readFileSync(`supabase/migrations/${name}.dryrun.sql`, 'utf8')
const REFUSED = /\b(DELETE|DROP|TRUNCATE)\b/i

describe('2026-10-31 migration files', () => {
  for (const name of MIGRATIONS) {
    it(`${name}: no refused word in the migration or its dry run`, () => {
      expect(mig(name)).not.toMatch(REFUSED)
      expect(dry(name)).not.toMatch(REFUSED)
    })
    it(`${name}: the dry run is BEGIN + the migration verbatim + checks + ROLLBACK`, () => {
      const d = dry(name)
      expect(d.split('\n').find(l => l.trim() && !l.startsWith('--'))).toBe('BEGIN;')
      expect(d).toContain(mig(name).trim())
      expect(d).toContain("RAISE EXCEPTION 'RESULTS: %'")
      expect(d.trimEnd().endsWith('ROLLBACK;')).toBe(true)
    })
    it(`${name}: never adds a column named family`, () => {
      expect(mig(name)).not.toMatch(/ADD COLUMN\s+family\b/i)
    })
  }
  for (const name of REPORTS) {
    it(`report ${name} is read only`, () => {
      const s = readFileSync(`supabase/datafix/${name}.sql`, 'utf8')
      expect(s).not.toMatch(REFUSED)
      expect(s).not.toMatch(/\b(INSERT|UPDATE|ALTER|CREATE)\b/i)
    })
  }
})

describe('2026-10-31-01 seed', () => {
  const s = mig('2026-10-31-01-alu-series-family')
  it('lists 27 families and 102 series, and its guard expects exactly those', () => {
    expect((s.match(/^\s*\('(ALM|SP|SMS|MN)', '[^']+', (ARRAY|NULL)/gm) || []).length).toBe(27)
    expect((s.match(/^\s*\('(ALM|SP|SMS|MN)', '[^']+', '[^']+'\)/gm) || []).length).toBe(102)
    expect(s).toContain('(expect 27)')
    expect(s).toContain('(expect 102)')
  })
  it('no series is listed twice', () => {
    const rows = [...s.matchAll(/^\s*\('(ALM|SP|SMS|MN)', '[^']+', '([^']+)'\)/gm)].map(m => `${m[1]}|${m[2]}`)
    expect(new Set(rows).size).toBe(rows.length)
  })
  it('STANDARD carries 1.0/1.2/1.5/1.8/2.0 for ALM, SMS and MN', () => {
    expect((s.match(/'STANDARD', ARRAY\[1\.0,1\.2,1\.5,1\.8,2\.0\]::numeric\[\]/g) || []).length).toBe(3)
  })
})

describe('2026-10-31-02 functions', () => {
  const s = mig('2026-10-31-02-alu-parts-stock-link')
  it('every function runs as the caller (RLS applies) and only authenticated may call it', () => {
    for (const fn of ['stock_item_purchase_prices', 'alu_add_stock_item_to_set', 'alu_add_new_part_to_set']) {
      expect(s).toMatch(new RegExp(`FUNCTION ${fn}\\([^)]*\\)\\s*RETURNS[\\s\\S]*?SECURITY INVOKER`))
      expect(s).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${fn}\\(`))
      expect(s).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${fn}\\([^)]*\\) TO authenticated`))
    }
    expect(s).not.toMatch(/SECURITY DEFINER/)
  })
})

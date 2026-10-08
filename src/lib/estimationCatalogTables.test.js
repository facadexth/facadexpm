// src/lib/estimationCatalogTables.test.js
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { ESTIMATION_CATALOG_TABLES } from './estimationCatalogTables.js'

const migrations = readdirSync('supabase/migrations')
  .filter(f => /^2026-10-10-0[123]-/.test(f))
  .map(f => readFileSync(`supabase/migrations/${f}`, 'utf8'))
  .join('\n')

describe('ESTIMATION_CATALOG_TABLES', () => {
  it('names only tables that the catalog migrations create', () => {
    for (const table of Object.values(ESTIMATION_CATALOG_TABLES)) {
      expect(migrations).toMatch(new RegExp(`CREATE TABLE ${table}\\b`))
    }
  })
  it('covers all 14 catalog tables exactly once', () => {
    const created = [...migrations.matchAll(/CREATE TABLE (\w+)/g)].map(m => m[1]).sort()
    expect(Object.values(ESTIMATION_CATALOG_TABLES).sort()).toEqual(created)
  })
  it('the keys are the ones buildCatalogIndex reads', () => {
    expect(Object.keys(ESTIMATION_CATALOG_TABLES)).toEqual(expect.arrayContaining([
      'providers', 'series', 'profiles', 'seriesProfiles', 'finishes', 'variants', 'parts', 'setItems', 'kgPrices', 'piecePrices', 'partPrices',
    ]))
  })
})

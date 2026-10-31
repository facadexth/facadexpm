// src/lib/defaultSeriesReaders.test.js
// Guard (spec 2026-10-31 section 5): the project's series is read only through the resolver (estimationInherit
// inheritedSeries / resolveSeriesId, seriesFamily). Any other source file that names default_series_id would bypass
// the project's series family.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED = new Set([
  'src/lib/estimationInherit.js',
  'src/lib/seriesFamily.js',
  'src/pages/estimation/projectDefaults.js',
])
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|jsx)$/.test(f) && !/\.test\.(js|jsx)$/.test(f)) out.push(p)
  }
  return out
}

describe('default_series_id is read only by the resolver', () => {
  it('no other source file names it', () => {
    const offenders = walk('src').filter(p => !ALLOWED.has(p) && readFileSync(p, 'utf8').includes('default_series_id'))
    expect(offenders).toEqual([])
  })
})

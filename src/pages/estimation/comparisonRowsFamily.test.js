import { describe, it, expect } from 'vitest'
import { comparisonRows } from './projectBomHelpers.js'

describe('comparisonRows with family candidates', () => {
  it('a family key counts as a chosen series; the key is passed through', () => {
    const rows = comparisonRows([
      { providerId: 'A', seriesKey: 'famA', finishId: 'f', aluminium: 1000, complete: true, unresolvedLines: 0 },
      { providerId: 'B', seriesKey: 'famB', finishId: 'f', aluminium: 900, complete: true, unresolvedLines: 0 },
      { providerId: 'C', seriesKey: '', finishId: 'f', aluminium: 0, complete: false, unresolvedLines: 1 },
    ], 'A')
    expect(rows[1]).toMatchObject({ seriesKey: 'famB', canApply: true, pending: false })
    expect(rows[2].pending).toBe(true)
  })
})

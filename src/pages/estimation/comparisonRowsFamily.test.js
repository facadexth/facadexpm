import { describe, it, expect } from 'vitest'
import { comparisonRows, compareStatusText } from './projectBomHelpers.js'

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

describe('comparisonRows passes the per-item reasons through', () => {
  it('failedItems from compareProviders reach the row; none = an empty list', () => {
    const failed = [{ id: 'i1', opening_no: 'W1', text: 'ซีรีส์หลักนี้ไม่มีชุดสำหรับประเภทนี้' }]
    const rows = comparisonRows([
      { providerId: 'A', seriesKey: 'famA', finishId: 'f', aluminium: 1000, complete: true, unresolvedLines: 0, failedItems: [] },
      { providerId: 'B', seriesKey: 'famB', finishId: 'f', aluminium: 0, complete: false, unresolvedLines: 2, failedItems: failed },
      { providerId: 'C', seriesKey: '', finishId: 'f', aluminium: 0, complete: false, unresolvedLines: 1 },
    ], 'A')
    expect(rows[1].failedItems).toEqual(failed)
    expect(rows[0].failedItems).toEqual([])
    expect(rows[2].failedItems).toEqual([])
  })
})

describe('compareStatusText', () => {
  const items = [{ id: 'i1', opening_no: 'W1', quantity: 2 }, { id: 'i2', opening_no: 'W2', quantity: 1 }, { id: 'i3', opening_no: 'W3', quantity: 1 }]
  const NO_SET = 'ซีรีส์หลักนี้ไม่มีชุดสำหรับประเภทนี้'
  it('no per-item reason: the old text, blaming missing profiles/prices', () => {
    expect(compareStatusText({ unresolvedLines: 3, failedItems: [] }, items)).toBe('คิดไม่ได้ 3 รายการ (ไม่มีหน้าตัด/ราคา)')
  })
  it('only per-item reasons: the reasons with their items, no profile/price claim', () => {
    const row = { unresolvedLines: 3, failedItems: [{ id: 'i1', opening_no: 'W1', text: NO_SET }, { id: 'i2', opening_no: 'W2', text: NO_SET }] }
    expect(compareStatusText(row, items)).toBe(`คิดไม่ได้ 3 รายการ · ${NO_SET}: W1, W2`)
  })
  it('reasons plus other unresolved lines: both are named', () => {
    const row = { unresolvedLines: 5, failedItems: [{ id: 'i1', opening_no: 'W1', text: NO_SET }, { id: 'i3', opening_no: 'W3', text: 'คิดราคาไม่ได้' }] }
    expect(compareStatusText(row, items)).toBe(`คิดไม่ได้ 5 รายการ · ${NO_SET}: W1 · คิดราคาไม่ได้: W3 · อีก 2 รายการไม่มีหน้าตัด/ราคา`)
  })
})

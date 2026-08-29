import { describe, it, expect } from 'vitest'
import { categoryBreakdown, groupSmallSlices } from './expenseChart.js'

describe('categoryBreakdown', () => {
  it('sums amounts per category', () => {
    const rows = [
      { category_name: 'วัสดุ', amount: 100 },
      { category_name: 'วัสดุ', amount: 50 },
      { category_name: 'ค่าแรง', amount: 200 },
    ]
    expect(categoryBreakdown(rows)).toEqual([
      { name: 'ค่าแรง', value: 200 },
      { name: 'วัสดุ', value: 150 },
    ])
  })

  it('groups missing category under a fallback label', () => {
    const rows = [{ category_name: null, amount: 30 }, { category_name: '', amount: 20 }]
    expect(categoryBreakdown(rows)).toEqual([{ name: 'ไม่ระบุหมวด', value: 50 }])
  })

  it('returns an empty array for no rows', () => {
    expect(categoryBreakdown([])).toEqual([])
    expect(categoryBreakdown(undefined)).toEqual([])
  })
})

describe('groupSmallSlices', () => {
  it('leaves slices unchanged when all are above the threshold', () => {
    const data = [{ name: 'A', value: 60 }, { name: 'B', value: 40 }]
    expect(groupSmallSlices(data, 0.05)).toEqual(data)
  })

  it('leaves a lone small slice alone instead of relabeling it', () => {
    const data = [{ name: 'A', value: 96 }, { name: 'B', value: 4 }]
    expect(groupSmallSlices(data, 0.05)).toEqual(data)
  })

  it('merges multiple small slices into a trailing "อื่นๆ" bucket, carrying the merged items for tooltip detail', () => {
    const data = [
      { name: 'A', value: 60 }, { name: 'B', value: 30 },
      { name: 'C', value: 4 }, { name: 'D', value: 3 }, { name: 'E', value: 3 },
    ]
    expect(groupSmallSlices(data, 0.05)).toEqual([
      { name: 'A', value: 60 }, { name: 'B', value: 30 },
      { name: 'อื่นๆ', value: 10, items: [
        { name: 'C', value: 4 }, { name: 'D', value: 3 }, { name: 'E', value: 3 },
      ] },
    ])
  })

  it('respects a custom threshold', () => {
    const data = [{ name: 'A', value: 70 }, { name: 'B', value: 20 }, { name: 'C', value: 10 }]
    expect(groupSmallSlices(data, 0.25)).toEqual([
      { name: 'A', value: 70 }, { name: 'อื่นๆ', value: 30, items: [
        { name: 'B', value: 20 }, { name: 'C', value: 10 },
      ] },
    ])
  })

  it('returns an empty array for no data', () => {
    expect(groupSmallSlices([])).toEqual([])
  })
})

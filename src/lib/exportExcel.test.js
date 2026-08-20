import { describe, it, expect } from 'vitest'
import { buildExportRows } from './exportExcel.js'

describe('buildExportRows', () => {
  it('maps rows through column accessors, keyed by header', () => {
    const rows = [
      { id: 1, amount_no_vat: 1000, description: 'ค่าแรง' },
      { id: 2, amount_no_vat: 2000, description: 'ค่าวัสดุ' },
    ]
    const columns = [
      { header: 'รายละเอียด', accessor: r => r.description },
      { header: 'ก่อน VAT', accessor: r => r.amount_no_vat },
    ]
    expect(buildExportRows(rows, columns)).toEqual([
      { 'รายละเอียด': 'ค่าแรง', 'ก่อน VAT': 1000 },
      { 'รายละเอียด': 'ค่าวัสดุ', 'ก่อน VAT': 2000 },
    ])
  })

  it('preserves column order regardless of row object key order', () => {
    const rows = [{ b: 2, a: 1 }]
    const columns = [
      { header: 'A', accessor: r => r.a },
      { header: 'B', accessor: r => r.b },
    ]
    const result = buildExportRows(rows, columns)
    expect(Object.keys(result[0])).toEqual(['A', 'B'])
  })

  it('passes numbers through as real numbers, not formatted strings', () => {
    const rows = [{ amount: 1234567.89 }]
    const columns = [{ header: 'ยอด', accessor: r => r.amount }]
    const result = buildExportRows(rows, columns)
    expect(result[0]['ยอด']).toBe(1234567.89)
    expect(typeof result[0]['ยอด']).toBe('number')
  })

  it('converts an accessor-returned Date to a real Date instance (passthrough)', () => {
    const rows = [{ date: '2026-01-15' }]
    const columns = [{ header: 'วันที่', accessor: r => new Date(r.date) }]
    const result = buildExportRows(rows, columns)
    expect(result[0]['วันที่']).toBeInstanceOf(Date)
  })

  it('returns an empty array for an empty rows array', () => {
    const columns = [{ header: 'A', accessor: r => r.a }]
    expect(buildExportRows([], columns)).toEqual([])
  })
})

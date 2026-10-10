import { describe, it, expect } from 'vitest'
import { emptyForm, formFromRow, buildPayload, missingRequired, resolveOptions, optionList, friendlyDbError, invalidNumbers } from './catalogForm.js'

const fields = [
  { key: 'name', label: 'ชื่อ', type: 'text', required: true },
  { key: 'weight', label: 'น้ำหนัก', type: 'number' },
  { key: 'kind', label: 'ชนิด', type: 'select', options: [{ value: 'a', label: 'A' }] },
  { key: 'effective_from', label: 'วันที่', type: 'date', required: true },
  { key: 'active', label: 'ใช้งาน', type: 'checkbox', default: true },
]

describe('emptyForm / formFromRow', () => {
  it('starts blank with checkbox defaults', () => {
    expect(emptyForm(fields)).toEqual({ name: '', weight: '', kind: '', effective_from: '', active: true })
  })
  it('lets the caller pre-fill', () => {
    expect(emptyForm(fields, { kind: 'a' }).kind).toBe('a')
  })
  it('turns null columns into empty inputs and keeps 0', () => {
    expect(formFromRow(fields, { name: 'x', weight: 0, kind: null, effective_from: '2026-01-01', active: false }))
      .toEqual({ name: 'x', weight: 0, kind: '', effective_from: '2026-01-01', active: false })
  })
})

describe('buildPayload', () => {
  it('trims text, nulls blanks, parses numbers, keeps booleans', () => {
    expect(buildPayload(fields, { name: '  กล่องร่อง ', weight: '0.85', kind: '', effective_from: '2026-01-01', active: true }))
      .toEqual({ name: 'กล่องร่อง', weight: 0.85, kind: null, effective_from: '2026-01-01', active: true })
  })
  it('an empty number becomes null, a typed 0 stays 0', () => {
    expect(buildPayload(fields, { name: 'x', weight: '', kind: '', effective_from: 'd', active: false }).weight).toBeNull()
    expect(buildPayload(fields, { name: 'x', weight: '0', kind: '', effective_from: 'd', active: false }).weight).toBe(0)
  })
})

describe('missingRequired', () => {
  it('lists labels of blank required fields', () => {
    expect(missingRequired(fields, { name: ' ', weight: '', kind: '', effective_from: '', active: true })).toEqual(['ชื่อ', 'วันที่'])
  })
  it('is empty when everything required is present', () => {
    expect(missingRequired(fields, { name: 'x', effective_from: '2026-01-01' })).toEqual([])
  })
})

describe('resolveOptions', () => {
  it('accepts an array or a function of the form', () => {
    expect(resolveOptions({ options: [{ value: 1, label: 'one' }] }, {})).toEqual([{ value: 1, label: 'one' }])
    expect(resolveOptions({ options: f => [{ value: f.p, label: 'dyn' }] }, { p: 'z' })).toEqual([{ value: 'z', label: 'dyn' }])
    expect(resolveOptions({}, {})).toEqual([])
  })
})

describe('optionList', () => {
  const rows = [{ id: '1', name: 'A', active: true }, { id: '2', name: 'B', active: false }, { id: '3', name: 'C' }]
  it('hides inactive rows from pickers', () => {
    expect(optionList(rows, r => r.name)).toEqual([{ value: '1', label: 'A' }, { value: '3', label: 'C' }])
  })
  it('still shows an inactive row that the edited record points at', () => {
    expect(optionList(rows, r => r.name, '2').map(o => o.value)).toEqual(['1', '2', '3'])
  })
})

describe('friendlyDbError', () => {
  it('explains duplicates, blocked deletes and bad values in Thai', () => {
    expect(friendlyDbError({ code: '23505', message: 'duplicate key' })).toMatch(/ซ้ำ/)
    expect(friendlyDbError({ code: '23503', message: 'fk' })).toMatch(/ผูกอยู่/)
    expect(friendlyDbError({ code: '23514', message: 'check' })).toMatch(/ไม่ถูกต้อง/)
    expect(friendlyDbError({ code: '42501', message: 'rls' })).toMatch(/สิทธิ์/)
    expect(friendlyDbError({ code: '23502', message: 'null value' })).toBe('กรุณากรอกค่าที่จำเป็นให้ครบ')
  })
  it('uses a table-specific duplicate message when given', () => {
    expect(friendlyDbError({ code: '23505' }, 'สีและความยาวนี้มีอยู่แล้ว')).toBe('สีและความยาวนี้มีอยู่แล้ว')
    expect(friendlyDbError({ code: '23505' })).toMatch(/ซ้ำ/)
    expect(friendlyDbError({ code: '23503' }, 'x')).toMatch(/ผูกอยู่/)
  })
  it('falls back to the raw message', () => {
    expect(friendlyDbError({ message: 'boom' })).toBe('boom')
    expect(friendlyDbError(null)).toBe('เกิดข้อผิดพลาด')
  })
})

describe('buildPayload blankAs', () => {
  it('uses blankAs for a blank number field instead of null', () => {
    const f = [{ key: 'discount_pct', type: 'number', blankAs: 0 }]
    expect(buildPayload(f, { discount_pct: '' })).toEqual({ discount_pct: 0 })
    expect(buildPayload(f, { discount_pct: '5' })).toEqual({ discount_pct: 5 })
  })
})

describe('butt_distance_mm field (optional column, omit when absent)', () => {
  const bf = [
    { key: 'name', label: 'ชื่อ', type: 'text' },
    { key: 'butt_distance_mm', label: 'ระยะชน', type: 'number', min: 0, nonNegative: true, omitWhenAbsent: true },
  ]
  it('is a blank string in the form', () => {
    expect(emptyForm(bf).butt_distance_mm).toBe('')
  })
  it('old row without the key reads blank', () => {
    expect(formFromRow(bf, { name: 'x' }).butt_distance_mm).toBe('')
  })
  it('blank with the key present on the row sends null (clears it)', () => {
    expect(buildPayload(bf, { name: 'x', butt_distance_mm: '' }, { name: 'x', butt_distance_mm: 5 }).butt_distance_mm).toBeNull()
    expect(buildPayload(bf, { name: 'x', butt_distance_mm: '' }, { name: 'x', butt_distance_mm: null }).butt_distance_mm).toBeNull()
  })
  it('blank on a row without the key, or a new row, omits the key', () => {
    expect('butt_distance_mm' in buildPayload(bf, { name: 'x', butt_distance_mm: '' }, { name: 'x' })).toBe(false)
    expect('butt_distance_mm' in buildPayload(bf, { name: 'x', butt_distance_mm: '' })).toBe(false)
  })
  it('a typed value is always sent', () => {
    expect(buildPayload(bf, { name: 'x', butt_distance_mm: '12.5' }, { name: 'x' }).butt_distance_mm).toBe(12.5)
    expect(buildPayload(bf, { name: 'x', butt_distance_mm: '0' }).butt_distance_mm).toBe(0)
  })
  it('negative or non-numeric gives a Thai error; blank and 0 are fine', () => {
    expect(invalidNumbers(bf, { butt_distance_mm: '-1' })).toBe('ระยะชน ต้องเป็นตัวเลขที่ไม่ติดลบ')
    expect(invalidNumbers(bf, { butt_distance_mm: 'abc' })).toBe('ระยะชน ต้องเป็นตัวเลขที่ไม่ติดลบ')
    expect(invalidNumbers(bf, { butt_distance_mm: '' })).toBeNull()
    expect(invalidNumbers(bf, { butt_distance_mm: '0' })).toBeNull()
    expect(invalidNumbers(bf, { butt_distance_mm: '7.5' })).toBeNull()
  })
})

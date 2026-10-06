import { describe, it, expect } from 'vitest'
import { isPeakAccountCode, isTaxId13, isBranch5, pickPeakFields } from './peakFields.js'

describe('pickPeakFields', () => {
  const keys = ['tax_id', 'branch_no']
  it('new record with blanks omits keys', () => {
    expect(pickPeakFields({ tax_id: '', branch_no: ' ' }, null, keys)).toEqual({})
  })
  it('new record with value includes trimmed value', () => {
    expect(pickPeakFields({ tax_id: ' 0105557083391 ', branch_no: '' }, null, keys)).toEqual({ tax_id: '0105557083391' })
  })
  it('edit that clears an existing value sends null', () => {
    expect(pickPeakFields({ tax_id: '', branch_no: '' }, { tax_id: '0105557083391', branch_no: null }, keys)).toEqual({ tax_id: null })
  })
  it('edit untouched blank omits key', () => {
    expect(pickPeakFields({ tax_id: '', branch_no: '' }, { tax_id: null }, keys)).toEqual({})
  })
})
describe('peak field validators', () => {
  it('accepts exactly 6 / 13 / 5 digits', () => {
    expect(isPeakAccountCode('530306')).toBe(true)
    expect(isPeakAccountCode('53030')).toBe(false)
    expect(isTaxId13('0105557083391')).toBe(true)
    expect(isTaxId13('010555708339')).toBe(false)
    expect(isBranch5('00000')).toBe(true)
    expect(isBranch5('0')).toBe(false)
  })
  it('rejects blanks and non-digits', () => {
    expect(isPeakAccountCode('')).toBe(false)
    expect(isTaxId13('01055570833ab')).toBe(false)
  })
})

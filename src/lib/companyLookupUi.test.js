import { describe, it, expect } from 'vitest'
import { computeAutofill } from './companyLookupUi.js'

const cand = { name: 'บริษัท ทดสอบ จำกัด', address: '99 ถนนสุขุมวิท กรุงเทพ 10110', taxId: '0107544000108' }

describe('computeAutofill', () => {
  it('fills empty fields, keeps the typed name, offers the registered name', () => {
    const r = computeAutofill(cand, { name: 'ทดสอบ', address: '', taxId: '' })
    expect(r.patch).toEqual({ taxId: '0107544000108', address: cand.address })
    expect(r.skipped).toEqual([])
    expect(r.nameSuggestion).toBe('บริษัท ทดสอบ จำกัด')
  })
  it('never overwrites non-empty fields: lists them as skipped', () => {
    const r = computeAutofill(cand, { name: 'x', address: 'ที่อยู่เดิม', taxId: '0105564000012' })
    expect(r.patch).toEqual({})
    expect(r.skipped.map(s => s.key)).toEqual(['taxId', 'address'])
    expect(r.skipped[0]).toMatchObject({ current: '0105564000012', ai: '0107544000108' })
  })
  it('equal values (formatting aside) are neither patched nor skipped', () => {
    const r = computeAutofill(cand, { name: 'บริษัท ทดสอบ จำกัด', address: '99  ถนนสุขุมวิท กรุงเทพ 10110', taxId: '0-1075-44000-10-8' })
    expect(r.patch).toEqual({})
    expect(r.skipped).toEqual([])
    expect(r.nameSuggestion).toBeNull()
  })
  it('handles Thai digits in the candidate and missing fields', () => {
    expect(computeAutofill({ name: 'ก', taxId: '๐๑๐๗๕๔๔๐๐๐๑๐๘' }, { taxId: '' }).patch).toEqual({ taxId: '0107544000108' })
    const r = computeAutofill({ name: 'ก', address: null, taxId: '' }, { address: 'เดิม', taxId: '' })
    expect(r.patch).toEqual({})
    expect(r.skipped).toEqual([])
  })
  it('tolerates null input', () => {
    expect(computeAutofill(null, null)).toEqual({ patch: {}, skipped: [], nameSuggestion: null })
  })
})

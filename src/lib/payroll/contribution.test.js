import { describe, it, expect } from 'vitest'
import { openingSave, balanceMap, OPENING_DEFAULT_AS_OF } from './contribution.js'

describe('openingSave (worker form → contribution_openings upsert)', () => {
  const base = { tenantId: 't1', workerId: 'w1' }

  it('skips when nothing was typed and there is no saved row', () => {
    expect(openingSave({ ...base, amount: '', asOf: '', hadRow: false })).toEqual({ skip: true })
    expect(openingSave({ ...base, amount: null, asOf: null, hadRow: false })).toEqual({ skip: true })
  })

  it('builds the row with a numeric amount rounded to 2 places', () => {
    expect(openingSave({ ...base, amount: '12345.678', asOf: '2026-09-30', hadRow: false }))
      .toEqual({ row: { tenant_id: 't1', worker_id: 'w1', amount: 12345.68, as_of: '2026-09-30' } })
  })

  it('needs an as-of date when an amount is given', () => {
    expect(openingSave({ ...base, amount: '100', asOf: '', hadRow: false }).error).toMatch(/วันที่/)
  })

  it('rejects negative or non-numeric amounts', () => {
    expect(openingSave({ ...base, amount: '-1', asOf: '2026-09-30', hadRow: false }).error).toBeTruthy()
    expect(openingSave({ ...base, amount: 'abc', asOf: '2026-09-30', hadRow: false }).error).toBeTruthy()
  })

  it('a saved row cleared to blank is stored as 0 (rows are never removed from the form)', () => {
    expect(openingSave({ ...base, amount: '', asOf: '2026-09-30', hadRow: true }))
      .toEqual({ row: { tenant_id: 't1', worker_id: 'w1', amount: 0, as_of: '2026-09-30' } })
  })

  it('empty amount with no saved row writes nothing, even with the default date', () => {
    expect(openingSave({ ...base, amount: '', asOf: '2026-09-30', hadRow: false })).toEqual({ skip: true })
    expect(openingSave({ ...base, amount: '   ', asOf: '2026-09-30', hadRow: false })).toEqual({ skip: true })
  })

  it('accepts thousands separators and spaces: "4,400.38" → 4400.38', () => {
    expect(openingSave({ ...base, amount: '4,400.38', asOf: '2026-09-30', hadRow: false }))
      .toEqual({ row: { tenant_id: 't1', worker_id: 'w1', amount: 4400.38, as_of: '2026-09-30' } })
    expect(openingSave({ ...base, amount: ' 12 345 ', asOf: '2026-09-30', hadRow: true }).row.amount).toBe(12345)
  })

  it('"abc" is an error, never 0, with or without a saved row', () => {
    expect(openingSave({ ...base, amount: 'abc', asOf: '2026-09-30', hadRow: false })).toEqual({ error: expect.any(String) })
    expect(openingSave({ ...base, amount: 'abc', asOf: '2026-09-30', hadRow: true })).toEqual({ error: expect.any(String) })
    expect(openingSave({ ...base, amount: '1,2a', asOf: '2026-09-30', hadRow: true }).row).toBeUndefined()
  })
})

describe('balanceMap (contribution_balances rows → worker_id → balance)', () => {
  it('maps numeric strings to numbers', () => {
    expect(balanceMap([{ worker_id: 'a', balance: '1140.00' }, { worker_id: 'b', balance: 0 }]))
      .toEqual({ a: 1140, b: 0 })
  })
  it('is empty for null / error results', () => {
    expect(balanceMap(null)).toEqual({})
  })
})

describe('OPENING_DEFAULT_AS_OF', () => {
  it('is end of September 2026 (FacadeX opening date)', () => {
    expect(OPENING_DEFAULT_AS_OF).toBe('2026-09-30')
  })
})

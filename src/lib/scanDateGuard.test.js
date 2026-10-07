import { describe, it, expect } from 'vitest'
import { decideScanDate, isValidIsoDate, formatIsoDmy } from './scanDateGuard.js'

const today = '2026-10-07'
describe('decideScanDate', () => {
  it('rejects a misread 2018 year when the form date is empty', () => {
    const r = decideScanDate({ guess: '2018-09-19', currentDate: '', today })
    expect(r).toMatchObject({ apply: false, date: '', reason: 'implausible', showNote: true })
  })
  it('keeps the user date when the guess is 2018', () => {
    const r = decideScanDate({ guess: '2018-09-19', currentDate: '2026-09-19', today })
    expect(r).toMatchObject({ apply: false, date: '2026-09-19', showNote: true })
  })
  it('applies a plausible guess into an empty date', () => {
    expect(decideScanDate({ guess: '2026-09-19', currentDate: '', today })).toMatchObject({ apply: true, date: '2026-09-19', showNote: false })
  })
  it('never overwrites a user-chosen date even with a plausible guess', () => {
    expect(decideScanDate({ guess: '2026-09-19', currentDate: '2026-10-01', today })).toMatchObject({ apply: false, date: '2026-10-01', reason: 'user_date', showNote: true })
  })
  it('same date: no note', () => {
    expect(decideScanDate({ guess: '2026-10-01', currentDate: '2026-10-01', today })).toMatchObject({ apply: false, showNote: false })
  })
  it('window edges: today-120 ok, -121 not; +14 ok, +15 not', () => {
    expect(decideScanDate({ guess: '2026-06-09', currentDate: '', today }).apply).toBe(true)
    expect(decideScanDate({ guess: '2026-06-08', currentDate: '', today }).apply).toBe(false)
    expect(decideScanDate({ guess: '2026-10-21', currentDate: '', today }).apply).toBe(true)
    expect(decideScanDate({ guess: '2026-10-22', currentDate: '', today }).apply).toBe(false)
  })
  it('invalid or missing guesses', () => {
    expect(decideScanDate({ guess: '2026-02-30', currentDate: '', today })).toMatchObject({ apply: false, reason: 'invalid', showNote: true })
    expect(decideScanDate({ guess: '19/09/2026', currentDate: '', today }).apply).toBe(false)
    expect(decideScanDate({ guess: null, currentDate: '2026-10-01', today })).toMatchObject({ apply: false, date: '2026-10-01', showNote: false })
  })
  it('helpers', () => {
    expect(isValidIsoDate('2026-02-29')).toBe(false)
    expect(isValidIsoDate('2028-02-29')).toBe(true)
    expect(formatIsoDmy('2018-09-19')).toBe('19/09/2018')
  })
})

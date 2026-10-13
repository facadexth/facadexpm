import { describe, it, expect } from 'vitest'
import { idCellCenters, ID_GROUPS, digits13, splitMoney, thaiDateParts, fitFontPt } from './wht50tawi.js'

describe('50 ทวิ form helpers', () => {
  it('has 13 cell centres, left to right, inside the printed boxes', () => {
    const c = idCellCenters(ID_GROUPS.payer)
    expect(c).toHaveLength(13)
    expect([...c].sort((a, b) => a - b)).toEqual(c)
    expect(c[0]).toBeGreaterThan(374)
    expect(c[12]).toBeLessThan(557)
  })
  it('keeps digits only, max 13', () => {
    expect(digits13('1-2345-67890-12-3')).toBe('1234567890123')
    expect(digits13('12345678901234567')).toHaveLength(13)
    expect(digits13(null)).toBe('')
  })
  it('splits money into baht and satang', () => {
    expect(splitMoney(12345.6)).toEqual({ baht: '12,345', satang: '60' })
    expect(splitMoney(0)).toEqual({ baht: '0', satang: '00' })
    expect(splitMoney('x')).toEqual({ baht: '', satang: '' })
  })
  it('converts to a Buddhist-era date', () => {
    expect(thaiDateParts('2026-10-05')).toEqual({ day: '5', month: 'ตุลาคม', year: '2569', short: '05/10/2569' })
    expect(thaiDateParts('2026-10-05T03:00:00Z').year).toBe('2569')
    expect(thaiDateParts('garbage')).toBeNull()
    expect(thaiDateParts('2026-13-01')).toBeNull()
  })
  it('shrinks long text to fit but never below the minimum', () => {
    expect(fitFontPt('สั้น', 200)).toBe(10)
    expect(fitFontPt('ก'.repeat(200), 100)).toBe(6)
    expect(fitFontPt('ก'.repeat(60), 300)).toBeLessThan(10)
  })
})

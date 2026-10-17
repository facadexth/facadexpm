import { describe, it, expect } from 'vitest'
import { siteCellLabel } from './cellLabel.js'

const base = { siteName: 'โครงการ บ้านคุณสมชาย ถนนรามอินทรา', siteNumber: 'S-001' }

describe('siteCellLabel', () => {
  it('desktop keeps the full name, or the site number, or a dash', () => {
    expect(siteCellLabel({ ...base, isPhone: false, shortName: 'สมชาย' })).toBe(base.siteName)
    expect(siteCellLabel({ isPhone: false, siteNumber: 'S-001' })).toBe('S-001')
    expect(siteCellLabel({ isPhone: false })).toBe('—')
  })
  it('phone uses the hand-set short name', () => {
    expect(siteCellLabel({ ...base, isPhone: true, shortName: 'สมชาย' })).toBe('สมชาย')
  })
  it('phone falls back to the automatic short name when short_name is unset', () => {
    const l = siteCellLabel({ ...base, isPhone: true, shortName: null })
    expect(l).toBe('บ้านคุณสมชาย')
    expect(siteCellLabel({ ...base, isPhone: true })).toBe(l)
  })
  it('central site shows its own name on phone, ignoring short_name', () => {
    expect(siteCellLabel({ isPhone: true, siteName: 'ส่วนกลาง', isDefault: true, shortName: 'x' })).toBe('ส่วนกลาง')
  })
  it('phone with no name falls back to the site number', () => {
    expect(siteCellLabel({ isPhone: true, siteNumber: 'S-9' })).toBe('S-9')
  })
})

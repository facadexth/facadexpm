import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './estimationSettings.js'

describe('mergeSettings', () => {
  it('no row gives the defaults', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.stock_length_m).toBe(6.4)
    expect(DEFAULT_SETTINGS.sealant_m_per_tube).toBe(10)
    expect(DEFAULT_SETTINGS.fixing_pitch_m).toBe(0.6)
  })
  it('numeric strings from the DB are coerced; 0 is a real kerf', () => {
    const s = mergeSettings({ stock_length_m: '6', kerf_square_mm: '0', fixing_min_per_side: '3' })
    expect(s.stock_length_m).toBe(6)
    expect(s.kerf_square_mm).toBe(0)
    expect(s.fixing_min_per_side).toBe(3)
  })
  it('invalid values fall back instead of becoming NaN / 0 / negative', () => {
    const s = mergeSettings({ stock_length_m: 0, sealant_m_per_tube: -1, fixing_pitch_m: 'abc', kerf_miter_mm: -2, fixing_min_per_side: 0 })
    expect(s.stock_length_m).toBe(6.4)
    expect(s.sealant_m_per_tube).toBe(10)
    expect(s.fixing_pitch_m).toBe(0.6)
    expect(s.kerf_miter_mm).toBe(10)
    expect(s.fixing_min_per_side).toBe(2)
  })
  it('part links pass through, empty becomes null', () => {
    expect(mergeSettings({ shim_part_id: 'p1', screw_part_id: '' }).shim_part_id).toBe('p1')
    expect(mergeSettings({ screw_part_id: '' }).screw_part_id).toBeNull()
  })
})

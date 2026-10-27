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

describe('price-structure defaults', () => {
  it('no row gives 10 / 45 / 2 / 100', () => {
    const s = mergeSettings({})
    expect([s.default_waste_pct, s.default_profit_pct, s.default_pm_pct, s.default_round_step]).toEqual([10, 45, 2, 100])
  })
  it('0 is allowed for the percentages, not for the round step; bad values fall back', () => {
    expect(mergeSettings({ default_waste_pct: '0', default_profit_pct: 0, default_pm_pct: '3' })).toMatchObject({ default_waste_pct: 0, default_profit_pct: 0, default_pm_pct: 3 })
    expect(mergeSettings({ default_round_step: 0 }).default_round_step).toBe(100)
    expect(mergeSettings({ default_round_step: 50 }).default_round_step).toBe(50)
    expect(mergeSettings({ default_waste_pct: -1, default_pm_pct: 'x' })).toMatchObject({ default_waste_pct: 10, default_pm_pct: 2 })
  })
})

describe('mergeSettings upper limit (final-fix 5)', () => {
  it('default pct above 1000 falls back to the default, exactly 1000 is kept; round step has no upper cap', () => {
    expect(mergeSettings({ default_waste_pct: 1001, default_profit_pct: 5000, default_pm_pct: 1001 })).toMatchObject({ default_waste_pct: 10, default_profit_pct: 45, default_pm_pct: 2 })
    expect(mergeSettings({ default_waste_pct: 1000 }).default_waste_pct).toBe(1000)
    expect(mergeSettings({ default_round_step: 5000 }).default_round_step).toBe(5000)
  })
})

describe('custom-length defaults', () => {
  it('no row gives 4 / 7 / 0.05 / 1000', () => {
    expect(mergeSettings({})).toMatchObject({ custom_len_min_m: 4, custom_len_max_m: 7, custom_len_step_m: 0.05, custom_moq_kg: 1000 })
  })
  it('a 0 step falls back; 0 MOQ is allowed; max below min resets both', () => {
    expect(mergeSettings({ custom_len_step_m: 0 }).custom_len_step_m).toBe(0.05)
    expect(mergeSettings({ custom_moq_kg: '0' }).custom_moq_kg).toBe(0)
    expect(mergeSettings({ custom_len_min_m: '5', custom_len_max_m: '6.5' })).toMatchObject({ custom_len_min_m: 5, custom_len_max_m: 6.5 })
    expect(mergeSettings({ custom_len_min_m: 8, custom_len_max_m: 6 })).toMatchObject({ custom_len_min_m: 4, custom_len_max_m: 7 })
  })
})

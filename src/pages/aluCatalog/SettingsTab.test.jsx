// The settings form round-trips every stored value: the custom-length fields are on the form, and a save never resets
// a stored value to its default.
import { describe, it, expect, vi } from 'vitest'
import { mergeSettings, DEFAULT_SETTINGS } from '../../lib/estimationSettings.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {} }))
const { toForm, formToSettings } = await import('./SettingsTab.jsx')

const stored = mergeSettings({ custom_len_min_m: 4.5, custom_len_max_m: 6.8, custom_len_step_m: 0.1, custom_moq_kg: 500, default_waste_pct: 7 })

describe('SettingsTab form', () => {
  it('the form carries the four custom-length settings with their stored values', () => {
    const form = toForm(stored)
    expect(form).toMatchObject({ custom_len_min_m: 4.5, custom_len_max_m: 6.8, custom_len_step_m: 0.1, custom_moq_kg: 500 })
  })
  it('saving the form unchanged keeps the non-default stored values', () => {
    const saved = formToSettings(stored, toForm(stored))
    expect(saved).toMatchObject({ custom_len_min_m: 4.5, custom_len_max_m: 6.8, custom_len_step_m: 0.1, custom_moq_kg: 500 })
    expect(saved.default_waste_pct).toBe(7)   // no field on this page, still kept
    expect(saved).toEqual(stored)
  })
  it('an edited minimum order is saved; a blank one falls back to the default', () => {
    expect(formToSettings(stored, { ...toForm(stored), custom_moq_kg: '2000' }).custom_moq_kg).toBe(2000)
    expect(formToSettings(stored, { ...toForm(stored), custom_moq_kg: '' }).custom_moq_kg).toBe(DEFAULT_SETTINGS.custom_moq_kg)
  })
})

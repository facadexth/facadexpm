import { describe, it, expect } from 'vitest'
import { companyHasModule, EXPLICIT_ONLY_MODULES, trialGrantsModule } from './modules.js'

describe('companyHasModule', () => {
  it('core features (no module key) are always available', () => {
    expect(companyHasModule(null, { isTrialActive: false, enabledModules: [] })).toBe(true)
    expect(companyHasModule(undefined, { isTrialActive: false, enabledModules: [] })).toBe(true)
  })
  it('the free trial opens ordinary modules', () => {
    expect(companyHasModule('payroll', { isTrialActive: true, enabledModules: [] })).toBe(true)
    expect(companyHasModule('line_bot', { isTrialActive: true, enabledModules: [] })).toBe(true)
  })
  it('the free trial does NOT open estimation', () => {
    expect(companyHasModule('estimation', { isTrialActive: true, enabledModules: [] })).toBe(false)
  })
  it('a company with its own estimation grant has it, trial or not', () => {
    expect(companyHasModule('estimation', { isTrialActive: false, enabledModules: ['estimation'] })).toBe(true)
    expect(companyHasModule('estimation', { isTrialActive: true, enabledModules: ['estimation'] })).toBe(true)
  })
  it('after the trial an ordinary module needs a grant', () => {
    expect(companyHasModule('payroll', { isTrialActive: false, enabledModules: [] })).toBe(false)
    expect(companyHasModule('payroll', { isTrialActive: false, enabledModules: ['payroll'] })).toBe(true)
  })
  it('keeps the explicit-only list to estimation for now', () => {
    expect(EXPLICIT_ONLY_MODULES).toEqual(['estimation'])
    expect(trialGrantsModule('estimation')).toBe(false)
    expect(trialGrantsModule('payroll')).toBe(true)
  })
})

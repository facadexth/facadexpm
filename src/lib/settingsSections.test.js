import { describe, it, expect } from 'vitest'
import { LEGACY_SECTION, resolveSettingsSection, redirectTab } from './settingsSections.js'

describe('resolveSettingsSection', () => {
  it('maps every old section id onto its new home', () => {
    expect(resolveSettingsSection('signature')).toBe('account')
    expect(resolveSettingsSection('bank_accounts')).toBe('company_profile')
    expect(resolveSettingsSection('travel')).toBe('location')
    expect(resolveSettingsSection('checkin_location')).toBe('location')
    for (const id of ['line_push', 'web_push', 'cheque_reminder', 'sign_method']) {
      expect(resolveSettingsSection(id)).toBe('communication')
    }
  })
  it('returns null for parts that left Settings (open the first section)', () => {
    for (const id of ['doc_style', 'payroll_items', 'payroll_bank']) expect(resolveSettingsSection(id)).toBeNull()
  })
  it('passes new ids through and treats nothing as no request', () => {
    expect(resolveSettingsSection('communication')).toBe('communication')
    expect(resolveSettingsSection('plan')).toBe('plan')
    expect(resolveSettingsSection(undefined)).toBeUndefined()
    expect(resolveSettingsSection('')).toBeUndefined()
  })
  it('lists the 11 retired ids', () => expect(Object.keys(LEGACY_SECTION)).toHaveLength(11))
})

describe('redirectTab', () => {
  it('sends communication_center to settings at the communication section, keeping the rest of the state', () => {
    expect(redirectTab('communication_center', { pending: 'issues_open', pendingCount: 2 }))
      .toEqual({ tab: 'settings', state: { pending: 'issues_open', pendingCount: 2, section: 'communication' } })
    expect(redirectTab('communication_center')).toEqual({ tab: 'settings', state: { section: 'communication' } })
  })
  it('leaves other tabs alone', () => {
    const state = { pending: 'leave_pending' }
    expect(redirectTab('hr', state)).toEqual({ tab: 'hr', state })
  })
})

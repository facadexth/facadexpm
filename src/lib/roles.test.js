import { describe, it, expect, beforeEach } from 'vitest'
import { canManageSites, canSeeMoney, canManageTeams, canApproveLeave, roleMeetsTab, setCurrentRole, getCurrentRole } from './roles.js'
import { getPageLevel } from './permissions.js'

beforeEach(() => { try { localStorage.clear() } catch { /* no storage */ } })

describe('roles', () => {
  it('PM manages sites, teams and leave but never sees money', () => {
    expect(canManageSites('PM')).toBe(true)
    expect(canSeeMoney('PM')).toBe(false)
    expect(canManageTeams('PM')).toBe(true)
    expect(canApproveLeave('PM')).toBe(true)
  })
  it('existing roles keep their abilities', () => {
    expect(canSeeMoney('ADMIN')).toBe(true)
    expect(canSeeMoney('OWNER')).toBe(true)
    expect(canManageSites('WORKER')).toBe(false)
    expect(canManageTeams('ADMIN')).toBe(false)
  })
  it('PM tab gate is keyed on tab id, not permKey', () => {
    expect(roleMeetsTab('PM', { id: 'sites', minRole: 'ADMIN' })).toBe(true)
    expect(roleMeetsTab('PM', { id: 'site_detail', minRole: 'ADMIN', permKey: 'sites' })).toBe(true)
    expect(roleMeetsTab('PM', { id: 'purchase_orders', minRole: 'ADMIN' })).toBe(true)
    expect(roleMeetsTab('PM', { id: 'inventory', minRole: 'ADMIN' })).toBe(true)
    expect(roleMeetsTab('PM', { id: 'supplier_credit_notes', minRole: 'ADMIN', permKey: 'purchase_orders' })).toBe(false)
    expect(roleMeetsTab('PM', { id: 'supplier_tax_invoices', minRole: 'ADMIN', permKey: 'purchase_orders' })).toBe(false)
    expect(roleMeetsTab('PM', { id: 'income', minRole: 'ADMIN' })).toBe(false)
    expect(roleMeetsTab('PM', { id: 'assign', minRole: 'WORKER' })).toBe(true)
    expect(roleMeetsTab('PM', { id: 'user_management', minRole: 'OWNER' })).toBe(false)
  })
  it('non-PM roles use the hierarchy unchanged', () => {
    expect(roleMeetsTab('ADMIN', { id: 'income', minRole: 'ADMIN' })).toBe(true)
    expect(roleMeetsTab('WORKER', { id: 'sites', minRole: 'ADMIN' })).toBe(false)
    expect(roleMeetsTab('OWNER', { id: 'user_management', minRole: 'OWNER' })).toBe(true)
  })
  it('PM page level defaults to none for unknown pages', () => {
    expect(getPageLevel('PM', 'deposits')).toBe('none')
    expect(getPageLevel('PM', 'expenses')).toBe('none')
    expect(getPageLevel('PM', 'sites')).toBe('edit')
    expect(getPageLevel('PM', 'purchase_orders')).toBe('view')
    expect(getPageLevel('ADMIN', 'deposits')).toBe('edit')
  })
  it('role store round-trips', () => {
    setCurrentRole('PM'); expect(getCurrentRole()).toBe('PM')
    setCurrentRole(null); expect(getCurrentRole()).toBe(null)
  })
})

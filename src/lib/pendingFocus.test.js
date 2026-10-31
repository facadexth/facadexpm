import { describe, it, expect } from 'vitest'
import { PENDING_ITEMS, pendingItemByKey, resolvePendingTab, parsePushHash } from './pendingItems.js'

describe('pendingItemByKey', () => {
  it('finds a known key and rejects unknown ones', () => {
    expect(pendingItemByKey('leave_pending').tab).toBe('hr')
    expect(pendingItemByKey('nope')).toBeNull()
    expect(pendingItemByKey(undefined)).toBeNull()
  })
})

describe('resolvePendingTab', () => {
  const only = (...ids) => (id) => ids.includes(id)
  it('opens the item page when the user can see it', () => {
    expect(resolvePendingTab('issues_open', only('communication_center', 'sites'), 'sites')).toBe('communication_center')
  })
  it('falls back to the next page the user can open', () => {
    expect(resolvePendingTab('issues_open', only('sites'), 'sites')).toBe('sites')
  })
  it('uses the push payload tab for unknown keys or no visible page', () => {
    expect(resolvePendingTab('issues_open', only('dashboard'), 'sites')).toBe('sites')
    expect(resolvePendingTab(null, only('hr'), 'hr')).toBe('hr')
    expect(resolvePendingTab('bogus', only('hr'), 'settings')).toBe('settings')
  })
  it('every pending item resolves to its own tab for an owner who sees everything', () => {
    for (const item of PENDING_ITEMS) expect(resolvePendingTab(item.key, () => true, null)).toBe(item.tab)
  })
})

describe('parsePushHash', () => {
  it('reads tab and pending from a notification launch URL', () => {
    expect(parsePushHash('#tab=hr&pending=leave_pending')).toEqual({ tab: 'hr', pending: 'leave_pending' })
  })
  it('keeps the old tab-only form working', () => {
    expect(parsePushHash('#tab=purchase_orders')).toEqual({ tab: 'purchase_orders', pending: null })
  })
  it('drops an unknown pending key and ignores other hashes', () => {
    expect(parsePushHash('#tab=hr&pending=evil')).toEqual({ tab: 'hr', pending: null })
    expect(parsePushHash('#access_token=abc')).toBeNull()
    expect(parsePushHash('')).toBeNull()
    expect(parsePushHash('#tab=')).toBeNull()
  })
})

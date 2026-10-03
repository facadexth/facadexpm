import { describe, it, expect } from 'vitest'
import { PENDING_ITEMS, visiblePendingItems, totalPending, badgeByTab, badgeForTab, formatBadge } from './pendingItems.js'

const all = () => true

describe('visiblePendingItems', () => {
  it('returns nothing before the counts have loaded', () => {
    expect(visiblePendingItems(null, all)).toEqual([])
    expect(visiblePendingItems(undefined, all)).toEqual([])
  })
  it('keeps only items with something waiting', () => {
    const items = visiblePendingItems({ leave_pending: 2, po_draft: 0, cheques_due: 1 }, all)
    expect(items.map(i => i.key)).toEqual(['leave_pending', 'cheques_due'])
  })
  it('hides items whose page the user cannot open', () => {
    const items = visiblePendingItems({ leave_pending: 2, invoices_due: 5 }, tab => tab !== 'invoices')
    expect(items.map(i => i.key)).toEqual(['leave_pending'])
  })
  it('ignores missing, null and non-numeric counts', () => {
    expect(visiblePendingItems({ leave_pending: null, po_draft: 'x', cheques_due: undefined }, all)).toEqual([])
  })
  it('reads counts that arrive as numeric strings', () => {
    expect(visiblePendingItems({ leave_pending: '3' }, all)[0].count).toBe(3)
  })
  it('gives every item a label, icon and a page', () => {
    for (const i of PENDING_ITEMS) {
      expect(i.label.length).toBeGreaterThan(3)
      expect(i.icon).toBeTruthy()
      expect(i.tab).toBeTruthy()
    }
  })
})

describe('totals and badges', () => {
  const items = visiblePendingItems({ leave_pending: 1, po_draft: 3, cheques_due: 3, invoices_due: 26 }, all)
  it('adds up the total', () => expect(totalPending(items)).toBe(33))
  it('groups counts by page', () => {
    expect(badgeByTab(items)).toEqual({ hr: 1, purchase_orders: 3, cheques: 3, invoices: 26 })
  })
  it('sums a group header from its sub-tabs', () => {
    const byTab = badgeByTab(items)
    expect(badgeForTab({ label: 'รายจ่าย', children: [{ id: 'expenses' }, { id: 'purchase_orders' }, { id: 'cheques' }] }, byTab)).toBe(6)
    expect(badgeForTab({ id: 'hr' }, byTab)).toBe(1)
    expect(badgeForTab({ id: 'inventory' }, byTab)).toBe(0)
  })
})

describe('formatBadge', () => {
  it('hides zero, shows small numbers, caps big ones', () => {
    expect(formatBadge(0)).toBe('')
    expect(formatBadge(undefined)).toBe('')
    expect(formatBadge(7)).toBe('7')
    expect(formatBadge(99)).toBe('99')
    expect(formatBadge(100)).toBe('99+')
  })
})

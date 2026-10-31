import { describe, it, expect } from 'vitest'
import { isLeavePending, isPoDraft, isIssueOpen, isChequeAwaitingAction, parseChequeWindowDays } from './pendingRules.js'

describe('row rules match what the tab numbers count', () => {
  it('leave: only pending', () => {
    expect(isLeavePending({ status: 'pending' })).toBe(true)
    expect(isLeavePending({ status: 'approved' })).toBe(false)
    expect(isLeavePending({ status: 'rejected' })).toBe(false)
    expect(isLeavePending(null)).toBe(false)
  })
  it('purchase order: only draft', () => {
    expect(isPoDraft({ status: 'draft' })).toBe(true)
    for (const s of ['ordered', 'received', 'cancelled']) expect(isPoDraft({ status: s })).toBe(false)
  })
  it('problem report: only open', () => {
    expect(isIssueOpen({ status: 'open' })).toBe(true)
    expect(isIssueOpen({ status: 'resolved' })).toBe(false)
  })
})

describe('cheque rule (same as the SQL: not cashed and check_date <= today + window)', () => {
  const today = '2026-10-04'
  it('today and within the window are due, past due stays due', () => {
    expect(isChequeAwaitingAction({ status: 'issued', check_date: '2026-10-04' }, 3, today)).toBe(true)
    expect(isChequeAwaitingAction({ status: 'issued', check_date: '2026-10-07' }, 3, today)).toBe(true)
    expect(isChequeAwaitingAction({ status: 'issued', check_date: '2026-09-01' }, 3, today)).toBe(true)
  })
  it('beyond the window is not due yet', () => {
    expect(isChequeAwaitingAction({ status: 'issued', check_date: '2026-10-08' }, 3, today)).toBe(false)
  })
  it('a cashed cheque is never due, however old', () => {
    expect(isChequeAwaitingAction({ status: 'cashed', check_date: '2026-09-01' }, 3, today)).toBe(false)
  })
  it('a cheque with no date is not due', () => {
    expect(isChequeAwaitingAction({ status: 'issued', check_date: null }, 3, today)).toBe(false)
    expect(isChequeAwaitingAction({ status: 'issued' }, 3, today)).toBe(false)
  })
  it('a window of 0 means only today and overdue', () => {
    expect(isChequeAwaitingAction({ status: 'issued', check_date: '2026-10-04' }, 0, today)).toBe(true)
    expect(isChequeAwaitingAction({ status: 'issued', check_date: '2026-10-05' }, 0, today)).toBe(false)
  })
})

describe('parseChequeWindowDays', () => {
  it('reads whole numbers, otherwise falls back to 3', () => {
    expect(parseChequeWindowDays('5')).toBe(5)
    expect(parseChequeWindowDays(' 0 ')).toBe(0)
    expect(parseChequeWindowDays('abc')).toBe(3)
    expect(parseChequeWindowDays('')).toBe(3)
    expect(parseChequeWindowDays(null)).toBe(3)
    expect(parseChequeWindowDays('-2')).toBe(3)
  })
})

import { isQuotationExpiring } from './pendingRules.js'
describe('isQuotationExpiring', () => {
  const q = (o) => ({ status: 'sent', on_hold: false, valid_until: '2026-10-11', ...o })
  it('marks a sent quotation 7 days or less before valid_until', () => {
    expect(isQuotationExpiring(q({}), '2026-10-04')).toBe(true)
    expect(isQuotationExpiring(q({ valid_until: '2026-10-12' }), '2026-10-04')).toBe(false)
    expect(isQuotationExpiring(q({ valid_until: '2026-10-01' }), '2026-10-04')).toBe(true)
  })
  it('ignores held, undated and non-sent quotations', () => {
    expect(isQuotationExpiring(q({ on_hold: true }), '2026-10-04')).toBe(false)
    expect(isQuotationExpiring(q({ valid_until: null }), '2026-10-04')).toBe(false)
    expect(isQuotationExpiring(q({ status: 'accepted' }), '2026-10-04')).toBe(false)
  })
})

import { isOffboardedInGroup } from './pendingRules.js'
describe('isOffboardedInGroup', () => {
  const base = { status: 'inactive', line_offboarding_alerted_at: '2026-10-13T02:00:00Z', line_group_removed_at: null }
  it('counts an inactive worker the bot noticed and nobody has removed', () => {
    expect(isOffboardedInGroup(base)).toBe(true)
  })
  it('stops counting once marked removed after the notice', () => {
    expect(isOffboardedInGroup({ ...base, line_group_removed_at: '2026-10-13T05:00:00Z' })).toBe(false)
  })
  it('counts again if the bot notices them after an earlier removal', () => {
    expect(isOffboardedInGroup({ ...base, line_group_removed_at: '2026-10-12T05:00:00Z' })).toBe(true)
  })
  it('ignores active workers and workers never noticed', () => {
    expect(isOffboardedInGroup({ ...base, status: 'active' })).toBe(false)
    expect(isOffboardedInGroup({ ...base, line_offboarding_alerted_at: null })).toBe(false)
    expect(isOffboardedInGroup(null)).toBe(false)
  })
})

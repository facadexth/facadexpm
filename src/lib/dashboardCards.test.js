import { describe, it, expect } from 'vitest'
import {
  bangkokDate, addMonthsYm, addDaysIso, monthEndIso, daysBetween, weekRange, thaiMonthLabel,
  expenseDueKey, dueByMonth, overdueExpenses, lateSites, todayCrewSummary,
  quotationCounts, pendingSummary, zeroProgressSites, repairsThisWeek, mergeCardPrefs,
} from './dashboardCards.js'

describe('Bangkok date helpers', () => {
  it('bangkokDate rolls over at Bangkok midnight, not UTC', () => {
    expect(bangkokDate(new Date('2026-10-20T16:59:00Z'))).toBe('2026-10-20')
    expect(bangkokDate(new Date('2026-10-20T17:00:00Z'))).toBe('2026-10-21')
  })
  it('addMonthsYm crosses years', () => {
    expect(addMonthsYm('2026-11', 3)).toBe('2027-02')
    expect(addMonthsYm('2026-01', -1)).toBe('2025-12')
  })
  it('monthEndIso handles leap years', () => {
    expect(monthEndIso('2028-02')).toBe('2028-02-29')
    expect(monthEndIso('2026-10')).toBe('2026-10-31')
  })
  it('daysBetween is whole calendar days', () => {
    expect(daysBetween('2026-10-01', '2026-10-21')).toBe(20)
    expect(daysBetween('2026-03-01', '2026-02-28')).toBe(-1)
  })
  it('addDaysIso crosses months', () => {
    expect(addDaysIso('2026-10-21', -60)).toBe('2026-08-22')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('weekRange is Monday..Sunday', () => {
    expect(weekRange('2026-10-21')).toEqual({ from: '2026-10-19', to: '2026-10-25' }) // Wed
    expect(weekRange('2026-10-25')).toEqual({ from: '2026-10-19', to: '2026-10-25' }) // Sun
    expect(weekRange('2026-10-19')).toEqual({ from: '2026-10-19', to: '2026-10-25' }) // Mon
  })
  it('thaiMonthLabel uses Buddhist year', () => {
    expect(thaiMonthLabel('2026-10')).toBe('ต.ค. 69')
    expect(thaiMonthLabel('2027-01')).toBe('ม.ค. 70')
  })
})

describe('expenseDueKey', () => {
  it('matches payment_forecast COALESCE(check_date, due_date, date)', () => {
    expect(expenseDueKey({ check_date: '2026-11-04', due_date: '2026-07-01', date: '2026-06-01' })).toBe('2026-11-04')
    expect(expenseDueKey({ due_date: '2026-07-01', date: '2026-06-01' })).toBe('2026-07-01')
    expect(expenseDueKey({ date: '2026-06-01' })).toBe('2026-06-01')
    expect(expenseDueKey({})).toBe(null)
  })
})

describe('dueByMonth', () => {
  const today = '2026-10-21'
  const expenses = [
    { amount: 100, due_date: '2026-10-25' },
    { amount: 50, due_date: '2026-10-05' },          // overdue: not in this month bucket
    { amount: 200, check_date: '2026-11-03', cheque_id: 'c1' },
    { amount: 300, due_date: '2027-01-31' },
    { amount: 999, due_date: '2027-02-01' },          // beyond 4 months
  ]
  const cheques = [
    { id: 'c1', status: 'issued', check_date: '2026-11-03' },
    { id: 'c2', status: 'cashed', check_date: '2026-11-10' },
    { id: 'c3', status: 'received', check_date: '2026-10-22' },
    { id: 'c4', status: 'issued', check_date: '2026-10-01' }, // overdue cheque: not counted
  ]
  it('buckets this month + next 3, excluding anything before today', () => {
    const rows = dueByMonth(expenses, cheques, today)
    expect(rows.map(r => r.month)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01'])
    expect(rows.map(r => r.amount)).toEqual([100, 200, 0, 300])
    expect(rows.map(r => r.count)).toEqual([1, 1, 0, 1])
    expect(rows.map(r => r.chequeCount)).toEqual([1, 1, 0, 0])
    expect(rows[0]).toMatchObject({ from: '2026-10-21', to: '2026-10-31', isCurrent: true })
    expect(rows[1]).toMatchObject({ from: '2026-11-01', to: '2026-11-30', isCurrent: false })
  })
  it('copes with null inputs', () => {
    expect(dueByMonth(null, null, today).every(r => r.amount === 0)).toBe(true)
  })
})

describe('overdueExpenses', () => {
  it('counts and sums unpaid rows whose due key is before today', () => {
    const r = overdueExpenses([
      { amount: 10, due_date: '2026-10-20' },
      { amount: 5, check_date: '2026-10-01', due_date: '2026-11-30' },
      { amount: 7, due_date: '2026-10-21' },
      { amount: 1 },
    ], '2026-10-21')
    expect(r).toEqual({ count: 2, total: 15 })
  })
})

describe('lateSites', () => {
  const sites = [
    { id: 'a', name: 'A', status: 'Ongoing', end_date: '2026-10-11' },
    { id: 'b', name: 'B', status: 'Ongoing', end_date: '2025-03-20' },
    { id: 'c', name: 'C', status: 'Completed', end_date: '2025-01-01' },
    { id: 'd', name: 'D', status: 'Ongoing', end_date: '2026-10-21' },
    { id: 'e', name: 'E', status: 'Ongoing', end_date: null },
    { id: 'f', name: 'F', status: 'Ongoing', end_date: '2026-10-20' },
    { id: 'g', name: 'G', status: 'Ongoing', end_date: '2026-09-01' },
    { id: 'h', name: 'H', status: 'Ongoing', end_date: '2026-08-01' },
  ]
  it('lists Ongoing sites past end_date, most late first, top N plus rest', () => {
    const r = lateSites(sites, '2026-10-21', 4)
    expect(r.total).toBe(5)
    expect(r.top.map(s => [s.id, s.daysLate])).toEqual([['b', 580], ['h', 81], ['g', 50], ['a', 10]])
    expect(r.rest).toBe(1)
  })
})

describe('todayCrewSummary', () => {
  const assignments = [
    { worker_id: 'w1', site_id: 's1', type: 'site', workers: { name: 'สมชาย', nickname: 'ชาย' }, sites: { name: 'Tower' } },
    { worker_id: 'w1', site_id: 's2', type: 'site', shift: 'evening', workers: { name: 'สมชาย' }, sites: { name: 'Home' } },
    { worker_id: 'w2', site_id: 's1', type: 'site', workers: { name: 'สมศรี' }, sites: { name: 'Tower' } },
    { worker_id: 'w3', site_id: 's1', type: 'leave', workers: { name: 'ลา' }, sites: { name: 'Tower' } },
    { worker_id: 'w4', site_id: 's2', type: 'factory', workers: { name: 'โรงงาน' }, sites: { name: 'Home' } },
  ]
  const checkins = [
    { worker_id: 'w1', site_id: 's1', checkin_at: '2026-10-21T01:00:00Z' },
    { worker_id: 'w4', site_id: null, is_assembly: true, checkin_at: '2026-10-21T00:30:00Z' },
  ]
  it('counts distinct workers on work types, with checked-in flags', () => {
    const r = todayCrewSummary(assignments, checkins)
    expect(r.total).toBe(3)
    expect(r.checkedIn).toBe(2)
    expect(r.notCheckedIn).toBe(1)
    expect(r.workers.find(w => w.id === 'w2')).toMatchObject({ name: 'สมศรี', checkedIn: false })
    expect(r.workers.find(w => w.id === 'w1')).toMatchObject({ name: 'ชาย', checkedIn: true })
  })
  it('per site: count and not-checked-in at that site (assembly counts everywhere)', () => {
    const r = todayCrewSummary(assignments, checkins)
    expect(r.bySite).toEqual([
      { siteId: 's2', name: 'Home', count: 2, notCheckedIn: 1 },
      { siteId: 's1', name: 'Tower', count: 2, notCheckedIn: 1 },
    ])
  })
})

describe('quotationCounts', () => {
  it('counts sent/accepted/draft', () => {
    expect(quotationCounts([{ status: 'sent' }, { status: 'sent' }, { status: 'draft' }, { status: 'accepted' }, { status: 'expired' }]))
      .toEqual({ sent: 2, accepted: 1, draft: 1, total: 5 })
  })
})

describe('pendingSummary', () => {
  it('keeps zero counts, drops items whose page the user cannot open, resolves fallbacks', () => {
    const r = pendingSummary({ po_draft: 2, leave_pending: '1' }, t => t !== 'repairs', ['po_draft', 'leave_pending', 'advances_pending', 'repair_pending'])
    expect(r.map(i => [i.key, i.count, i.tab])).toEqual([['po_draft', 2, 'purchase_orders'], ['leave_pending', 1, 'hr'], ['advances_pending', 0, 'hr']])
  })
})

describe('zeroProgressSites', () => {
  it('sites with people today whose progress is 0 or unknown, sorted by crew', () => {
    const bySite = [{ siteId: 's1', name: 'A', count: 6 }, { siteId: 's2', name: 'B', count: 3 }, { siteId: 's3', name: 'C', count: 1 }]
    expect(zeroProgressSites(bySite, { s1: 37.7, s2: 0 }).map(s => s.siteId)).toEqual(['s2', 's3'])
  })
})

describe('repairsThisWeek', () => {
  it('groups repair-linked assignments by ticket, earliest date first', () => {
    const r = repairsThisWeek([
      { repair_ticket_id: 't1', date: '2026-10-23', site_id: 's1', worker_id: 'w1', sites: { name: 'A' } },
      { repair_ticket_id: 't1', date: '2026-10-23', site_id: 's1', worker_id: 'w2', sites: { name: 'A' } },
      { repair_ticket_id: 't2', date: '2026-10-20', site_id: 's2', worker_id: 'w1', sites: { name: 'B' } },
      { repair_ticket_id: null, date: '2026-10-20', site_id: 's2', worker_id: 'w3' },
    ])
    expect(r).toEqual([
      { ticketId: 't2', date: '2026-10-20', siteName: 'B', crew: 1 },
      { ticketId: 't1', date: '2026-10-23', siteName: 'A', crew: 2 },
    ])
  })
})

describe('mergeCardPrefs', () => {
  const ids = ['a', 'b', 'c']
  it('defaults when nothing saved or garbage', () => {
    expect(mergeCardPrefs(null, ids)).toEqual({ order: ids, hidden: [] })
    expect(mergeCardPrefs('{bad', ids)).toEqual({ order: ids, hidden: [] })
  })
  it('appends new card ids to an old saved order and drops unknown ids', () => {
    expect(mergeCardPrefs(JSON.stringify({ order: ['b', 'zz', 'a'], hidden: ['a'] }), ids)).toEqual({ order: ['b', 'a', 'c'], hidden: ['a'] })
  })
})

import { describe, it, expect } from 'vitest'
import {
  BOARD_COLUMNS, DONE_WINDOW_DAYS, groupTickets, dropAction, movePatch, ageText, crewCounts,
  warrantyOf, matchesWarrantyFilter, pickThumbs, bangkokDateOf,
} from './repairBoard.js'

const TODAY = '2026-10-20'
const t = (id, status, extra = {}) => ({ id, status, created_at: '2026-10-19T03:00:00Z', ...extra })

describe('BOARD_COLUMNS', () => {
  it('is the five board statuses in order (declined is a filter, not a column)', () => {
    expect(BOARD_COLUMNS.map((c) => c.status)).toEqual(['pending_review', 'received', 'scheduled', 'in_progress', 'done'])
    expect(BOARD_COLUMNS.map((c) => c.label)).toEqual(['รอพิจารณา', 'รับเรื่อง', 'นัดเข้า', 'กำลังซ่อม', 'เสร็จ'])
  })
})

describe('bangkokDateOf', () => {
  it('turns a UTC timestamp into the Bangkok calendar date', () => {
    expect(bangkokDateOf('2026-10-19T17:30:00Z')).toBe('2026-10-20')
    expect(bangkokDateOf('2026-10-19T16:59:00Z')).toBe('2026-10-19')
    expect(bangkokDateOf(null)).toBe('')
    expect(bangkokDateOf('nonsense')).toBe('')
  })
})

describe('groupTickets', () => {
  it('puts every ticket in its status column', () => {
    const g = groupTickets([t('a', 'pending_review'), t('b', 'received'), t('c', 'scheduled', { scheduled_date: '2026-10-22' }),
      t('d', 'in_progress'), t('e', 'done', { done_at: '2026-10-19T03:00:00Z' }), t('f', 'declined', { declined_at: '2026-10-19T03:00:00Z' })], TODAY)
    expect(g.pending_review.map((x) => x.id)).toEqual(['a'])
    expect(g.received.map((x) => x.id)).toEqual(['b'])
    expect(g.scheduled.map((x) => x.id)).toEqual(['c'])
    expect(g.in_progress.map((x) => x.id)).toEqual(['d'])
    expect(g.done.map((x) => x.id)).toEqual(['e'])
    expect(g.declined.map((x) => x.id)).toEqual(['f'])
  })
  it('keeps done tickets for the last 60 days only (Bangkok date)', () => {
    expect(DONE_WINDOW_DAYS).toBe(60)
    const g = groupTickets([
      t('in', 'done', { done_at: '2026-08-21T03:00:00Z' }), // exactly 60 days ago
      t('out', 'done', { done_at: '2026-08-20T03:00:00Z' }), // 61 days ago
      t('edge', 'done', { done_at: '2026-08-20T17:30:00Z' }), // 21 Aug in Bangkok
      t('none', 'done', { done_at: null }),
    ], TODAY)
    expect(g.done.map((x) => x.id).sort()).toEqual(['edge', 'in'])
  })
  it('keeps declined tickets for the same 60-day window', () => {
    const g = groupTickets([t('old', 'declined', { declined_at: '2026-07-01T03:00:00Z' }), t('new', 'declined', { declined_at: '2026-10-01T03:00:00Z' })], TODAY)
    expect(g.declined.map((x) => x.id)).toEqual(['new'])
  })
  it('sorts: waiting columns newest first, scheduled by appointment, done newest first', () => {
    const g = groupTickets([
      t('p1', 'pending_review', { created_at: '2026-10-18T03:00:00Z' }),
      t('p2', 'pending_review', { created_at: '2026-10-19T03:00:00Z' }),
      t('s1', 'scheduled', { scheduled_date: '2026-10-25', scheduled_start: '09:00:00' }),
      t('s2', 'scheduled', { scheduled_date: '2026-10-22', scheduled_start: '13:00:00' }),
      t('s3', 'scheduled', { scheduled_date: '2026-10-22', scheduled_start: '08:00:00' }),
      t('d1', 'done', { done_at: '2026-10-10T03:00:00Z' }),
      t('d2', 'done', { done_at: '2026-10-15T03:00:00Z' }),
    ], TODAY)
    expect(g.pending_review.map((x) => x.id)).toEqual(['p2', 'p1'])
    expect(g.scheduled.map((x) => x.id)).toEqual(['s3', 's2', 's1'])
    expect(g.done.map((x) => x.id)).toEqual(['d2', 'd1'])
  })
  it('ignores unknown statuses and survives empty input', () => {
    const g = groupTickets([t('x', 'weird')], TODAY)
    expect(Object.values(g).flat()).toEqual([])
    expect(groupTickets(null, TODAY).pending_review).toEqual([])
  })
})

describe('dropAction', () => {
  it('moves straight when the status rules allow it', () => {
    expect(dropAction('pending_review', 'received')).toBe('move')
    expect(dropAction('scheduled', 'in_progress')).toBe('move')
    expect(dropAction('scheduled', 'received')).toBe('move')
    expect(dropAction('done', 'in_progress')).toBe('move')
  })
  it('opens the detail modal for นัดเข้า (needs a date) and เสร็จ (needs an after photo)', () => {
    expect(dropAction('received', 'scheduled')).toBe('modal')
    expect(dropAction('in_progress', 'scheduled')).toBe('modal')
    expect(dropAction('in_progress', 'done')).toBe('modal')
  })
  it('does nothing for a forbidden move or the same column', () => {
    expect(dropAction('pending_review', 'scheduled')).toBe('none')
    expect(dropAction('pending_review', 'done')).toBe('none')
    expect(dropAction('received', 'in_progress')).toBe('none')
    expect(dropAction('declined', 'received')).toBe('none')
    expect(dropAction('received', 'received')).toBe('none')
  })
})

describe('movePatch', () => {
  const now = '2026-10-20T05:00:00.000Z'
  it('stamps the target time on a forward move or when leaving pending_review', () => {
    expect(movePatch('pending_review', 'received', now)).toEqual({ status: 'received', received_at: now })
    expect(movePatch('pending_review', 'declined', now)).toEqual({ status: 'declined', declined_at: now })
    expect(movePatch('scheduled', 'in_progress', now)).toEqual({ status: 'in_progress', started_at: now })
    expect(movePatch('in_progress', 'done', now)).toEqual({ status: 'done', done_at: now })
  })
  it('sets only the status when the forward move has no timestamp of its own', () => {
    expect(movePatch('received', 'scheduled', now)).toEqual({ status: 'scheduled' })
  })
  it('stamps declined_at when a received ticket is declined (terminal, not a step back)', () => {
    expect(movePatch('received', 'declined', now)).toEqual({ status: 'declined', declined_at: now })
  })
  it('scheduled -> received changes the status only and keeps the first received_at', () => {
    expect(movePatch('scheduled', 'received', now)).toEqual({ status: 'received' })
  })
  it('in_progress -> scheduled changes the status only', () => {
    expect(movePatch('in_progress', 'scheduled', now)).toEqual({ status: 'scheduled' })
  })
  it('done -> in_progress reopens: clears done_at and keeps the first started_at', () => {
    expect(movePatch('done', 'in_progress', now)).toEqual({ status: 'in_progress', done_at: null })
  })
})

describe('ageText', () => {
  const now = Date.parse('2026-10-20T05:00:00Z')
  it('says how long ago, in Thai', () => {
    expect(ageText('2026-10-20T04:59:40Z', now)).toBe('เมื่อสักครู่')
    expect(ageText('2026-10-20T04:50:00Z', now)).toBe('10 นาทีที่แล้ว')
    expect(ageText('2026-10-20T03:00:00Z', now)).toBe('2 ชม.ที่แล้ว')
    expect(ageText('2026-10-17T05:00:00Z', now)).toBe('3 วันที่แล้ว')
  })
  it('is empty for a missing or bad timestamp, and never negative', () => {
    expect(ageText(null, now)).toBe('')
    expect(ageText('x', now)).toBe('')
    expect(ageText('2026-10-20T06:00:00Z', now)).toBe('เมื่อสักครู่')
  })
})

describe('crewCounts', () => {
  it('counts distinct workers per ticket on its appointment date only', () => {
    const tickets = [{ id: 'a', scheduled_date: '2026-10-22' }, { id: 'b', scheduled_date: '2026-10-23' }]
    const rows = [
      { repair_ticket_id: 'a', worker_id: 'w1', date: '2026-10-22' },
      { repair_ticket_id: 'a', worker_id: 'w1', date: '2026-10-22' }, // same worker twice
      { repair_ticket_id: 'a', worker_id: 'w2', date: '2026-10-22' },
      { repair_ticket_id: 'a', worker_id: 'w3', date: '2026-10-21' }, // other day
      { repair_ticket_id: 'b', worker_id: 'w1', date: '2026-10-22' }, // not b's date
      { repair_ticket_id: 'zzz', worker_id: 'w9', date: '2026-10-22' },
    ]
    expect(crewCounts(tickets, rows)).toEqual({ a: 2 })
  })
  it('handles nulls', () => {
    expect(crewCounts(null, null)).toEqual({})
  })
})

describe('warrantyOf / matchesWarrantyFilter', () => {
  const site = (handover, months) => ({ sites: { handover_date: handover, warranty_months: months } })
  it('reads the warranty from the ticket site', () => {
    expect(warrantyOf(site('2026-01-10', 12), TODAY).kind).toBe('active')
    expect(warrantyOf(site('2024-01-10', 12), TODAY).kind).toBe('expired')
    expect(warrantyOf(site(null, 12), TODAY).kind).toBe('not_handed_over')
    expect(warrantyOf(site('2026-01-10', 0), TODAY).kind).toBe('none')
    expect(warrantyOf({}, TODAY).kind).toBe('not_handed_over')
  })
  it('filters ในประกัน = active, หมดประกัน = expired or no warranty, all = everything', () => {
    expect(matchesWarrantyFilter(site('2026-01-10', 12), 'active', TODAY)).toBe(true)
    expect(matchesWarrantyFilter(site('2024-01-10', 12), 'active', TODAY)).toBe(false)
    expect(matchesWarrantyFilter(site('2024-01-10', 12), 'expired', TODAY)).toBe(true)
    expect(matchesWarrantyFilter(site('2026-01-10', 0), 'expired', TODAY)).toBe(true)
    expect(matchesWarrantyFilter(site(null, 12), 'expired', TODAY)).toBe(false)
    expect(matchesWarrantyFilter(site(null, 12), 'all', TODAY)).toBe(true)
  })
})

describe('pickThumbs', () => {
  it('keeps the first 3 media per ticket by created_at and counts the rest', () => {
    const rows = [
      { id: 1, ticket_id: 'a', created_at: '2026-10-19T03:00:04Z' },
      { id: 2, ticket_id: 'a', created_at: '2026-10-19T03:00:01Z' },
      { id: 3, ticket_id: 'a', created_at: '2026-10-19T03:00:02Z' },
      { id: 4, ticket_id: 'a', created_at: '2026-10-19T03:00:03Z' },
      { id: 5, ticket_id: 'b', created_at: '2026-10-19T03:00:00Z' },
    ]
    const out = pickThumbs(rows)
    expect(out.a.shown.map((m) => m.id)).toEqual([2, 3, 4])
    expect(out.a.more).toBe(1)
    expect(out.b.shown.map((m) => m.id)).toEqual([5])
    expect(out.b.more).toBe(0)
  })
  it('orders customer media first, then before, then after, within the cap', () => {
    const rows = [
      { id: 'af', ticket_id: 'a', role: 'after', created_at: '2026-10-19T03:00:00Z' },
      { id: 'be', ticket_id: 'a', role: 'before', created_at: '2026-10-19T03:00:01Z' },
      { id: 'c2', ticket_id: 'a', role: 'customer', created_at: '2026-10-19T03:00:03Z' },
      { id: 'c1', ticket_id: 'a', role: 'customer', created_at: '2026-10-19T03:00:02Z' },
    ]
    const out = pickThumbs(rows)
    expect(out.a.shown.map((m) => m.id)).toEqual(['c1', 'c2', 'be'])
    expect(out.a.more).toBe(1)
  })
})

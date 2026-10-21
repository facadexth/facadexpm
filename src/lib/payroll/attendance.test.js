import { describe, it, expect } from 'vitest'
import { summarizeAttendance, findAssignGaps } from './attendance.js'

describe('summarizeAttendance', () => {
  const shifts = [
    { worker_id: 'a', type: 'site', date: '2026-10-16', ot_hours: 1, confirmed_at: null },
    { worker_id: 'a', type: 'site', date: '2026-10-18', ot_hours: 0, confirmed_at: '2026-10-18T08:00:00Z' }, // Sunday
    { worker_id: 'a', type: 'factory', date: '2026-10-23', ot_hours: 0 },                                      // holiday
    { worker_id: 'a', type: 'office', date: '2026-10-24' },
    { worker_id: 'a', type: 'leave_personal', date: '2026-10-26' },
    { worker_id: 'a', type: 'leave', date: '2026-10-27' },
    { worker_id: 'a', type: 'leave_sick', date: '2026-10-28' },
    { worker_id: 'a', type: 'site', date: '2026-10-31', ot_hours: 0, confirmed_at: null },                    // last day of month
  ]
  it('counts worked shifts as half days, leave and OT, with confirmation off', () => {
    const r = summarizeAttendance({ shifts, otRows: [{ worker_id: 'a', ot_hours: 2 }], holidayDates: ['2026-10-23'], requireConfirm: false })
    expect(r.a).toEqual({ daysWorked: 2.5, leavePersonalDays: 1, leaveSickDays: 0.5, otHours: 3, holidayShifts: 2, officeDays: 0.5 })
  })
  it('drops unconfirmed site shifts from days and holiday premium when confirmation is required', () => {
    const r = summarizeAttendance({ shifts, otRows: [], holidayDates: ['2026-10-23'], requireConfirm: true })
    expect(r.a.daysWorked).toBe(1.5)
    expect(r.a.holidayShifts).toBe(2)
  })
  it('creates an entry for a worker who only has OT rows', () => {
    const r = summarizeAttendance({ shifts: [], otRows: [{ worker_id: 'b', ot_hours: 4 }], holidayDates: [] })
    expect(r.b.otHours).toBe(4)
  })
})

describe('findAssignGaps', () => {
  const workers = [
    { id: 'a', name: 'กร', show_in_assign: true },
    { id: 'h', name: 'โปรย', show_in_assign: false },
  ]
  // October 2026, "today" = Wed 7 Oct: days 1..7 are in scope; 4 Oct is Sunday; 5 Oct is a company holiday
  const shifts = [
    { worker_id: 'a', date: '2026-10-01', shift: 'morning' }, { worker_id: 'a', date: '2026-10-01', shift: 'evening' },
    { worker_id: 'a', date: '2026-10-02', shift: 'morning' },                                                   // evening missing
    { worker_id: 'a', date: '2026-10-03', shift: 'morning' }, { worker_id: 'a', date: '2026-10-03', shift: 'evening' },
    { worker_id: 'a', date: '2026-10-06', shift: 'morning' }, { worker_id: 'a', date: '2026-10-06', shift: 'evening' },
  ]
  it('lists Mon–Sat non-holiday days up to today with a missing shift, skipping hidden workers', () => {
    const r = findAssignGaps({ workers, shifts, holidayDates: ['2026-10-05'], year: 2026, month: 10, today: '2026-10-07' })
    expect(r).toEqual([{ worker_id: 'a', name: 'กร', dates: [
      { date: '2026-10-02', missing: ['evening'] },
      { date: '2026-10-07', missing: ['morning', 'evening'] },
    ] }])
  })
  it('checks the whole month when today is after it', () => {
    const r = findAssignGaps({ workers: [workers[0]], shifts: [], holidayDates: [], year: 2026, month: 2, today: '2026-10-07' })
    expect(r[0].dates).toHaveLength(24) // Feb 2026: 28 days − 4 Sundays
  })
  it('returns nothing for a month that has not started', () => {
    expect(findAssignGaps({ workers, shifts: [], holidayDates: [], year: 2026, month: 11, today: '2026-10-07' })).toEqual([])
  })
})

describe('summarizeAttendance checkinOt (คิด OT จากเวลาเช็คอิน)', () => {
  const shifts = [
    { worker_id: 'a', type: 'site', date: '2026-10-01', ot_hours: 1 },
    { worker_id: 'a', type: 'site', date: '2026-10-02', ot_hours: 2 },
  ]
  const otRows = [{ worker_id: 'a', date: '2026-10-01', ot_hours: 3 }, { worker_id: 'a', date: '2026-10-03', ot_hours: 0.5 }]
  it('without checkinOt: unchanged sum', () => {
    expect(summarizeAttendance({ shifts, otRows }).a.otHours).toBe(6.5)
  })
  it('a date with a check-in work time replaces that date\'s manual OT; other dates keep theirs', () => {
    const r = summarizeAttendance({ shifts, otRows, checkinOt: { 'a|2026-10-01': 2.47 } })
    expect(r.a.otHours).toBeCloseTo(2.47 + 2 + 0.5, 5)
  })
  it('adds a worker whose only OT is from check-in (on a counted site shift)', () => {
    expect(summarizeAttendance({ shifts: [{ worker_id: 'z', type: 'site', date: '2026-10-01', ot_hours: 0 }], otRows: [], checkinOt: { 'z|2026-10-01': 1.5 } }).z.otHours).toBe(1.5)
  })
})

describe('checkinOt only on counted site shifts', () => {
  it('ignores check-in OT on a date without a counted site shift (unconfirmed, leave, none)', () => {
    const shifts = [
      { worker_id: 'a', type: 'site', date: '2026-10-01', ot_hours: 0, confirmed_at: null },
      { worker_id: 'a', type: 'leave_sick', date: '2026-10-02', ot_hours: 0 },
      { worker_id: 'a', type: 'site', date: '2026-10-03', ot_hours: 0, confirmed_at: 'x' },
    ]
    const checkinOt = { 'a|2026-10-01': 1, 'a|2026-10-02': 1, 'a|2026-10-03': 1, 'a|2026-10-04': 1 }
    expect(summarizeAttendance({ shifts, otRows: [], requireConfirm: true, checkinOt }).a.otHours).toBe(1)
    expect(summarizeAttendance({ shifts, otRows: [], requireConfirm: false, checkinOt }).a.otHours).toBe(2)
  })
})

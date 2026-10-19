import { describe, it, expect } from 'vitest'
import { planRepairAssignments, repairShifts } from './repairAssign.js'

const D = '2026-10-23'
const plan = (o) => planRepairAssignments({ workerIds: ['w1'], date: D, start: '09:00', durationHours: 2, existing: [], ...o })

describe('repairShifts', () => {
  it('morning only when the window ends by 12:00', () => {
    expect(repairShifts('09:00', 2)).toEqual(['morning'])
  })
  it('start 11:00 + 1 h ends exactly 12:00 -> morning only', () => {
    expect(repairShifts('11:00', 1)).toEqual(['morning'])
  })
  it('evening only when starting at or after 12:00', () => {
    expect(repairShifts('12:00', 3)).toEqual(['evening'])
    expect(repairShifts('13:30', 2)).toEqual(['evening'])
  })
  it('crossing noon -> both shifts', () => {
    expect(repairShifts('10:00', 3)).toEqual(['morning', 'evening'])
    expect(repairShifts('11:30', 1)).toEqual(['morning', 'evening'])
  })
  it('accepts HH:MM:SS and no duration', () => {
    expect(repairShifts('08:00:00', null)).toEqual(['morning'])
  })
  it('throws on an unreadable start time', () => {
    expect(() => repairShifts('', 2)).toThrow()
  })
})

describe('planRepairAssignments', () => {
  it('morning only', () => {
    expect(plan({})).toEqual({ rows: [{ worker_id: 'w1', date: D, shift: 'morning' }], conflicts: [] })
  })
  it('evening only', () => {
    expect(plan({ start: '13:00', durationHours: 3 }).rows).toEqual([{ worker_id: 'w1', date: D, shift: 'evening' }])
  })
  it('crossing noon -> both shifts', () => {
    expect(plan({ start: '10:00', durationHours: 4 }).rows).toEqual([
      { worker_id: 'w1', date: D, shift: 'morning' },
      { worker_id: 'w1', date: D, shift: 'evening' },
    ])
  })
  it('start 11:00 + 1 h -> morning only', () => {
    expect(plan({ start: '11:00', durationHours: 1 }).rows).toEqual([{ worker_id: 'w1', date: D, shift: 'morning' }])
  })
  it('start 12:00 -> evening', () => {
    expect(plan({ start: '12:00', durationHours: 1 }).rows).toEqual([{ worker_id: 'w1', date: D, shift: 'evening' }])
  })
  it('a taken (worker, date, shift) is a conflict and never a row', () => {
    const ex = { worker_id: 'w1', date: D, shift: 'evening', type: 'site' }
    const r = plan({ start: '10:00', durationHours: 4, existing: [ex] })
    expect(r.rows).toEqual([{ worker_id: 'w1', date: D, shift: 'morning' }])
    expect(r.conflicts).toEqual([{ worker_id: 'w1', date: D, shift: 'evening', existing: ex }])
  })
  it('existing rows on another date or shift are not conflicts', () => {
    const r = plan({ existing: [{ worker_id: 'w1', date: '2026-10-24', shift: 'morning' }, { worker_id: 'w1', date: D, shift: 'evening' }] })
    expect(r.conflicts).toEqual([])
    expect(r.rows).toHaveLength(1)
  })
  it('multiple workers, each gets every shift; conflicts only for the taken one', () => {
    const r = plan({ workerIds: ['w1', 'w2', 'w3'], start: '10:00', durationHours: 4, existing: [{ worker_id: 'w2', date: D, shift: 'morning' }] })
    expect(r.rows).toEqual([
      { worker_id: 'w1', date: D, shift: 'morning' },
      { worker_id: 'w1', date: D, shift: 'evening' },
      { worker_id: 'w2', date: D, shift: 'evening' },
      { worker_id: 'w3', date: D, shift: 'morning' },
      { worker_id: 'w3', date: D, shift: 'evening' },
    ])
    expect(r.conflicts.map((c) => `${c.worker_id}|${c.shift}`)).toEqual(['w2|morning'])
  })
  it('duplicate worker ids are planned once', () => {
    expect(plan({ workerIds: ['w1', 'w1'] }).rows).toHaveLength(1)
  })
})


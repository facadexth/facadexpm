import { describe, it, expect } from 'vitest'
import { buildCheckinDays, otHoursForDay, summarizeTaps, dayAssemblyMode, otByWorkerDate } from './checkinDay.js'

const D = '2026-10-21'
const T = (hhmm) => `${D}T${hhmm}:00+07:00`
const LOC = 'loc-fac'
const sites = { a: { name: 'SOAP OPERA', assembly_mode: null }, b: { name: 'B', assembly_mode: null }, x: { name: 'X', assembly_mode: 'none' } }
const ON = { assemblyMode: 'assembly', assemblyLocationId: LOC }
const OFF = { assemblyMode: 'none', assemblyLocationId: null }
const asg = (worker_id, site_id, shift = 'morning', extra = {}) => ({ worker_id, date: D, site_id, shift, type: 'site', is_team_leader: false, ...extra })
const siteRow = (worker_id, site_id, inAt, outAt) => ({ worker_id, date: D, site_id, checkin_location_id: null, is_assembly: false, checkin_at: inAt, checkout_at: outAt })
const asmRow = (worker_id, leave, ret) => ({ worker_id, date: D, site_id: null, checkin_location_id: LOC, is_assembly: true, checkin_at: leave, checkout_at: ret })

describe('dayAssemblyMode', () => {
  it('first site of the day decides; site override beats the tenant default', () => {
    expect(dayAssemblyMode([asg('w', 'a')], sites, ON)).toBe('assembly')
    expect(dayAssemblyMode([asg('w', 'x')], sites, ON)).toBe('none')
    expect(dayAssemblyMode([asg('w', 'b', 'evening'), asg('w', 'x', 'morning')], sites, ON)).toBe('none')
    expect(dayAssemblyMode([asg('w', 'a')], { a: { name: 'A', assembly_mode: 'assembly' } }, OFF)).toBe('none') // no location set
    expect(dayAssemblyMode([asg('w', 'a')], sites, OFF)).toBe('none')
  })
})

describe('buildCheckinDays', () => {
  it('full assembly day: 4 self points, travel and work time (mockup ต้น)', () => {
    const [d] = buildCheckinDays({
      checkins: [asmRow('w1', T('07:42'), T('18:10')), siteRow('w1', 'a', T('09:05'), T('16:30'))],
      assignments: [asg('w1', 'a'), asg('w1', 'a', 'evening')], sites, settings: ON,
    })
    expect(d.mode).toBe('assembly')
    expect(d.leave).toEqual({ at: T('07:42'), source: 'self' })
    expect(d.arrive).toEqual({ at: T('09:05'), source: 'self', siteId: 'a' })
    expect(d.depart).toEqual({ at: T('16:30'), source: 'self', siteId: 'a' })
    expect(d.return).toEqual({ at: T('18:10'), source: 'self' })
    expect(d.travelOutMin).toBe(83)
    expect(d.travelBackMin).toBe(100)
    expect(d.workMin).toBe(628)
    expect(d.flag).toBe(false)
    expect(d.tapsMade).toBe(4)
    expect(d.tapsExpected).toBe(4)
  })

  it('no-assembly day: first arrival to last departure, 2 taps per site', () => {
    const [d] = buildCheckinDays({
      checkins: [siteRow('w2', 'a', T('08:00'), T('12:00')), siteRow('w2', 'b', T('13:10'), T('17:20'))],
      assignments: [asg('w2', 'a'), asg('w2', 'b', 'evening')], sites, settings: OFF,
    })
    expect(d.mode).toBe('none')
    expect(d.leave).toBeNull()
    expect(d.return).toBeNull()
    expect(d.workMin).toBe(560)
    expect(d.depart.siteId).toBe('b')
    expect(d.tapsExpected).toBe(4)
    expect(d.tapsMade).toBe(4)
    expect(d.travelOutMin).toBeNull()
  })

  it('missed leave/return: filled from the team leader at the same site, labelled leader', () => {
    const days = buildCheckinDays({
      checkins: [
        asmRow('lead', T('07:30'), T('18:00')), siteRow('lead', 'a', T('09:00'), T('16:30')),
        siteRow('w3', 'a', T('09:01'), T('16:31')),
      ],
      assignments: [asg('lead', 'a', 'morning', { is_team_leader: true }), asg('w3', 'a')], sites, settings: ON,
    })
    const d = days.find(x => x.workerId === 'w3')
    expect(d.leave).toEqual({ at: T('07:30'), source: 'leader' })
    expect(d.return).toEqual({ at: T('18:00'), source: 'leader' })
    expect(d.flag).toBe(false)
    expect(d.workMin).toBe(630)
    expect(d.tapsMade).toBe(2)
    expect(d.tapsExpected).toBe(4)
  })

  it('leader missed too: falls back to site times and flags red', () => {
    const [d] = buildCheckinDays({
      checkins: [siteRow('w4', 'a', T('09:00'), T('16:00'))],
      assignments: [asg('w4', 'a')], sites, settings: ON,
    })
    expect(d.leave).toEqual({ at: T('09:00'), source: 'site' })
    expect(d.return).toEqual({ at: T('16:00'), source: 'site' })
    expect(d.flag).toBe(true)
    expect(d.travelOutMin).toBeNull()
    expect(d.workMin).toBe(420)
  })

  it('still out: work time unknown', () => {
    const [d] = buildCheckinDays({
      checkins: [asmRow('w5', T('07:50'), null), siteRow('w5', 'a', T('08:40'), null)],
      assignments: [asg('w5', 'a')], sites, settings: ON,
    })
    expect(d.workMin).toBeNull()
    expect(d.complete).toBe(false)
  })
})

describe('otHoursForDay', () => {
  it('work beyond the standard day, half for a one-shift day', () => {
    expect(otHoursForDay({ workMin: 628, shiftCount: 2 }, 8, 0)).toBe(2.47)
    expect(otHoursForDay({ workMin: 400, shiftCount: 2 }, 8)).toBe(0)
    expect(otHoursForDay({ workMin: 300, shiftCount: 1 }, 8, 0)).toBe(1)
    expect(otHoursForDay({ workMin: null, shiftCount: 2 }, 8)).toBeNull()
  })
  it('otByWorkerDate keys only days with a known work time', () => {
    const m = otByWorkerDate([{ workerId: 'w', date: D, workMin: 600, shiftCount: 2 }, { workerId: 'w', date: '2026-10-22', workMin: null, shiftCount: 2 }], 8, 0)
    expect(m).toEqual({ [`w|${D}`]: 2 })
  })
})

describe('summarizeTaps', () => {
  it('days worked, taps made/expected and % self-tapped per worker', () => {
    const s = summarizeTaps([
      { workerId: 'w', date: '2026-10-01', tapsMade: 4, tapsExpected: 4 },
      { workerId: 'w', date: '2026-10-02', tapsMade: 2, tapsExpected: 4 },
      { workerId: 'v', date: '2026-10-02', tapsMade: 0, tapsExpected: 2 },
    ])
    expect(s.w).toEqual({ daysWorked: 2, tapsMade: 6, tapsExpected: 8, pct: 75 })
    expect(s.v).toEqual({ daysWorked: 1, tapsMade: 0, tapsExpected: 2, pct: 0 })
  })
})

describe('review fixes', () => {
  it('break is subtracted (halved on one-shift days) before the standard', () => {
    expect(otHoursForDay({ workMin: 628, shiftCount: 2 }, 8, 60)).toBe(1.47)
    expect(otHoursForDay({ workMin: 540, shiftCount: 2 }, 8, 60)).toBe(0)
    expect(otHoursForDay({ workMin: 330, shiftCount: 1 }, 8, 60)).toBe(1)
    expect(otHoursForDay({ workMin: 628, shiftCount: 2 }, 8)).toBe(1.47) // default break 60
  })
  it('flagged days give no check-in OT', () => {
    expect(otByWorkerDate([{ workerId: 'w', date: D, workMin: 700, shiftCount: 2, flag: true }], 8, 60)).toEqual({})
  })
  it('assembly day with a point still missing after all fallbacks is flagged', () => {
    const [d] = buildCheckinDays({ checkins: [asmRow('w6', T('07:50'), null), siteRow('w6', 'a', T('08:40'), null)], assignments: [asg('w6', 'a')], sites, settings: ON })
    expect(d.return).toBeNull()
    expect(d.flag).toBe(true)
  })
})

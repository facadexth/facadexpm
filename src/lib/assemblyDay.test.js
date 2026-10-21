import { describe, it, expect } from 'vitest'
import { planAssemblyDay, stepLabel, stepAction, chooseStepByGps, distanceM, skipStep, assemblyLinkReplyText } from '../../supabase/functions/_shared/assembly-day.ts'

const site = (siteId, siteName, nextAction = 'check_in', shifts = ['morning']) => ({ siteId, siteName, shifts, nextAction, atFactory: false })
const FAC = 'โรงงาน (ส่วนกลาง)'

describe('planAssemblyDay', () => {
  it('nothing tapped: leave the assembly point first, 4 steps for one site', () => {
    const p = planAssemblyDay([site('a', 'SOAP OPERA')], null, FAC)
    expect(p.steps.map(s => s.kind)).toEqual(['assembly_leave', 'site_arrive', 'site_leave', 'assembly_return'])
    expect(p.next.kind).toBe('assembly_leave')
    expect(p.steps.every(s => !s.done)).toBe(true)
  })

  it('after leave: arrive at the site', () => {
    const p = planAssemblyDay([site('a', 'A')], { leave_at: 't1', return_at: null }, FAC)
    expect(p.next).toMatchObject({ kind: 'site_arrive', siteId: 'a' })
    expect(p.steps[0].done).toBe(true)
  })

  it('site open: leave the site', () => {
    const p = planAssemblyDay([site('a', 'A', 'check_out')], { leave_at: 't1', return_at: null }, FAC)
    expect(p.next).toMatchObject({ kind: 'site_leave', siteId: 'a' })
  })

  it('two sites: arrive/leave A, then arrive/leave B, then return', () => {
    const sites = [site('a', 'A', 'done'), site('b', 'B', 'check_in', ['evening'])]
    const p = planAssemblyDay(sites, { leave_at: 't1', return_at: null }, FAC)
    expect(p.steps.map(s => `${s.kind}:${s.siteId ?? ''}`)).toEqual([
      'assembly_leave:', 'site_arrive:a', 'site_leave:a', 'site_arrive:b', 'site_leave:b', 'assembly_return:',
    ])
    expect(p.next).toMatchObject({ kind: 'site_arrive', siteId: 'b' })
  })

  it('all sites done: return', () => {
    const p = planAssemblyDay([site('a', 'A', 'done')], { leave_at: 't1', return_at: null }, FAC)
    expect(p.next.kind).toBe('assembly_return')
  })

  it('missed leave but already at the site: never asks for leave again', () => {
    const p = planAssemblyDay([site('a', 'A', 'done')], null, FAC)
    expect(p.next.kind).toBe('assembly_return')
    const open = planAssemblyDay([site('a', 'A', 'check_out')], null, FAC)
    expect(open.next.kind).toBe('site_leave')
  })

  it('everything tapped: done (next null)', () => {
    const p = planAssemblyDay([site('a', 'A', 'done')], { leave_at: 't1', return_at: 't2' }, FAC)
    expect(p.next).toBeNull()
    expect(p.steps.every(s => s.done)).toBe(true)
  })
})

describe('stepLabel / stepAction', () => {
  it('uses the real assembly location name', () => {
    expect(stepLabel({ kind: 'assembly_leave', placeName: FAC })).toEqual({ emoji: '🏭', title: `ออกจาก${FAC}`, place: FAC })
    expect(stepLabel({ kind: 'assembly_return', placeName: 'Head Office' }).title).toBe('กลับถึงHead Office')
    expect(stepLabel({ kind: 'site_arrive', placeName: 'A' })).toEqual({ emoji: '🏗️', title: 'ถึงไซท์', place: 'A' })
    expect(stepLabel({ kind: 'site_leave', placeName: 'A' }).title).toBe('ออกจากไซท์')
  })
  it('maps to the check-in/check-out on/off settings', () => {
    expect(stepAction('assembly_leave')).toBe('check_in')
    expect(stepAction('site_arrive')).toBe('check_in')
    expect(stepAction('site_leave')).toBe('check_out')
    expect(stepAction('assembly_return')).toBe('check_out')
  })
})

describe('chooseStepByGps', () => {
  const leave = { kind: 'assembly_leave' }
  const arrive = { kind: 'site_arrive', siteId: 'a' }
  it('inside the expected place: that step', () => {
    expect(chooseStepByGps({ next: leave, nextDistance: 35, skip: arrive, skipDistance: 9000, radius: 200 })).toEqual({ step: leave })
  })
  it('already at the first site after a missed leave tap: the skip step', () => {
    expect(chooseStepByGps({ next: leave, nextDistance: 9000, skip: arrive, skipDistance: 20, radius: 200 })).toEqual({ step: arrive })
  })
  it('far from both: refused with the distance to the expected place', () => {
    expect(chooseStepByGps({ next: leave, nextDistance: 2400, skip: arrive, skipDistance: 9000, radius: 200 })).toEqual({ refused: true, distanceM: 2400 })
  })
  it('unknown distance (no coordinates): leave it to the RPC', () => {
    expect(chooseStepByGps({ next: arrive, nextDistance: null, skip: null, skipDistance: null, radius: 200 })).toEqual({ step: arrive })
  })
})

describe('distanceM', () => {
  it('about 111 m per 0.001 deg latitude', () => {
    const d = distanceM(13.7563, 100.5018, 13.7573, 100.5018)
    expect(d).toBeGreaterThan(105)
    expect(d).toBeLessThan(117)
  })
})

describe('skipStep', () => {
  it('only when the expected step is leaving the assembly point: the first site arrival', () => {
    const p = planAssemblyDay([site('a', 'A'), site('b', 'B')], null, FAC)
    expect(skipStep(p)).toMatchObject({ kind: 'site_arrive', siteId: 'a' })
    expect(skipStep(planAssemblyDay([site('a', 'A')], { leave_at: 't', return_at: null }, FAC))).toBeNull()
  })
})

describe('assemblyLinkReplyText', () => {
  it('names the step and the place', () => {
    expect(assemblyLinkReplyText({ kind: 'assembly_leave', placeName: FAC }, 'https://x/f/1'))
      .toBe(`🏭 กดลิงก์นี้เพื่อบันทึก "ออกจาก${FAC}" ครับ (ใช้ได้ 30 นาที ต้องอนุญาตให้เว็บใช้ตำแหน่งของคุณ)\nhttps://x/f/1`)
    expect(assemblyLinkReplyText({ kind: 'site_arrive', placeName: 'A' }, 'L')).toContain('"ถึงไซท์ A"')
  })
})

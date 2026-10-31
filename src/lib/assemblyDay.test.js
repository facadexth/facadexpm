import { describe, it, expect } from 'vitest'
import { planAssemblyDay, stepLabel, stepAction, chooseStepByGps, distanceM, skipStep, assemblyLinkReplyText, nextStepHint } from '../../supabase/functions/_shared/assembly-day.ts'

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
  it('expected leave: the first site arrival; expected arrival: the return', () => {
    const p = planAssemblyDay([site('a', 'A'), site('b', 'B')], null, FAC)
    expect(skipStep(p)).toMatchObject({ kind: 'site_arrive', siteId: 'a' })
    expect(skipStep(planAssemblyDay([site('a', 'A')], { leave_at: 't', return_at: null }, FAC))).toMatchObject({ kind: 'assembly_return' })
  })
})

describe('assemblyLinkReplyText', () => {
  it('names the step and the place', () => {
    expect(assemblyLinkReplyText({ kind: 'assembly_leave', placeName: FAC }, 'https://x/f/1'))
      .toBe(`🏭 กดลิงก์นี้เพื่อบันทึก "ออกจาก${FAC}" ครับ (ใช้ได้ 30 นาที ต้องอนุญาตให้เว็บใช้ตำแหน่งของคุณ)\nhttps://x/f/1`)
    expect(assemblyLinkReplyText({ kind: 'site_arrive', placeName: 'A' }, 'L')).toContain('"ถึงไซท์ A"')
  })
})

describe('review fixes', () => {
  it('skipped site: expected arrival, already back at the assembly point -> return', () => {
    const p = planAssemblyDay([site('a', 'A', 'done'), site('b', 'B', 'check_in', ['evening'])], { leave_at: 't', return_at: null }, FAC)
    expect(p.next.kind).toBe('site_arrive')
    expect(skipStep(p)).toMatchObject({ kind: 'assembly_return' })
    const ret = skipStep(p)
    expect(chooseStepByGps({ next: p.next, nextDistance: 9000, skip: ret, skipDistance: 30, radius: 200 })).toEqual({ step: ret })
  })
  it('no skip from an open site or once returned', () => {
    expect(skipStep(planAssemblyDay([site('a', 'A', 'check_out')], { leave_at: 't', return_at: null }, FAC))).toBeNull()
  })
  it('factory work never says ถึงไซท์: uses the work-place name', () => {
    const st = { kind: 'site_arrive', placeName: `${FAC} — งานบ้านคุณบิ๊ก`, atFactory: true }
    expect(stepLabel(st).title).toBe(`ถึง${FAC} — งานบ้านคุณบิ๊ก`)
    expect(stepLabel({ ...st, kind: 'site_leave' }).title).toBe(`ออกจาก${FAC} — งานบ้านคุณบิ๊ก`)
    const txt = assemblyLinkReplyText(st, 'L')
    expect(txt).not.toContain('ถึงไซท์')
    expect(txt).toContain(`"ถึง${FAC} — งานบ้านคุณบิ๊ก"`)
  })
})

describe('nextStepHint', () => {
  const stepsOf = (sites, asm = null) => planAssemblyDay(sites, asm, FAC).steps
  it('first leave with 1 site: go check in at that site', () => {
    const steps = stepsOf([site('a', 'A')])
    expect(nextStepHint(steps, steps[0])).toBe('ต่อไป: ไปเช็คอินถึงไซท์ A')
  })
  it('first leave with 2 sites: next site + the day order', () => {
    const steps = stepsOf([site('a', 'A'), site('b', 'B')])
    expect(nextStepHint(steps, steps[0])).toBe('ต่อไป: ไปเช็คอินถึงไซท์ A\nไซท์วันนี้: A → B')
  })
  it('leave a site with another site pending', () => {
    const steps = stepsOf([site('a', 'A', 'check_out'), site('b', 'B')], { leave_at: 't', return_at: null })
    const tapped = steps.find(s => s.kind === 'site_leave' && s.siteId === 'a')
    expect(nextStepHint(steps, tapped)).toBe('ต่อไป: ไปเช็คอินถึงไซท์ B')
  })
  it('leave the last site on an assembly day: remind to tap back at the assembly point', () => {
    const steps = stepsOf([site('a', 'A', 'done'), site('b', 'B', 'check_out')], { leave_at: 't', return_at: null })
    const tapped = steps.find(s => s.kind === 'site_leave' && s.siteId === 'b')
    expect(nextStepHint(steps, tapped)).toBe(`อย่าลืมกดเช็คอิน กลับถึง${FAC} เมื่อถึงแล้ว`)
  })
  it('leave the last site on a no-assembly day: no hint', () => {
    const steps = stepsOf([site('a', 'A', 'check_out')]).filter(s => s.kind !== 'assembly_leave' && s.kind !== 'assembly_return')
    expect(nextStepHint(steps, steps.find(s => s.kind === 'site_leave'))).toBe('')
  })
})

describe('factory-only day: single check-in / check-out', () => {
  const fac = (id, name, next = 'check_in') => ({ ...site(id, name, next), atFactory: true })
  it('only factory work: no assembly steps, plain เช็คอินที่', () => {
    const p = planAssemblyDay([fac('f', FAC)], null, FAC)
    expect(p.steps.map(s => s.kind)).toEqual(['site_arrive', 'site_leave'])
    expect(p.next.kind).toBe('site_arrive')
    expect(stepLabel(p.next).title).toBe(`เช็คอินที่${FAC}`)
  })
  it('checked in: next is เช็คเอาท์ที่, no hint after it', () => {
    const p = planAssemblyDay([fac('f', FAC, 'check_out')], null, FAC)
    expect(stepLabel(p.next).title).toBe(`เช็คเอาท์ที่${FAC}`)
    expect(nextStepHint(p.steps, p.next)).toBe('')
  })
  it('checked out: day done, no return step', () => {
    expect(planAssemblyDay([fac('f', FAC, 'done')], null, FAC).next).toBeNull()
  })
  it('mixed day (factory + site) keeps the full flow', () => {
    const p = planAssemblyDay([fac('f', FAC), site('a', 'A')], null, FAC)
    expect(p.steps[0].kind).toBe('assembly_leave')
    expect(p.steps.at(-1).kind).toBe('assembly_return')
  })
})

import { describe, it, expect } from 'vitest'
import { offcutTabs, offcutConsumer, voidBlockers, codesText, cutErrorWithBlockers } from './offcutHelpers.js'

const off = (id, code, o = {}) => ({ id, code, profile_id: 'A', finish_id: 'F', length_m: 1.2, status: 'in_stock', source_project_id: 'p0', source_plan_id: 'cpX', used_plan_id: null, ...o })
const groupInfo = { 'A|F': { profile_id: 'A', finish_id: 'F', name: 'เฟรมข้าง' } }
const pc = no => ({ length_m: 0.5, opening_no: no, role_name: 'ตั้ง' })
const plans = [
  { id: 'cp9', project_id: 'p9', status: 'issued', issued_at: '2026-10-28T03:00:00Z',
    plan: { groups: [{ key: 'A|F', bars: [], offcutBars: [
      { pieces: [pc('T-01'), pc('T-01')], offcut: { id: 'm2', code: 'OC-0011' } },
      { pieces: [pc('T-02')], offcut: { id: 'm4', code: 'OC-0013' } },
    ] }] } },
  { id: 'cp8', project_id: 'hidden', status: 'issued', issued_at: '2026-10-29T03:00:00Z', plan: { groups: [] } },
]
const projectNames = { p0: 'บ้านพี่วัฒน์', p9: 'HOSPITAL' }

describe('offcutTabs', () => {
  const offcuts = [
    off('o2', 'OC-0002'),
    off('o1', 'OC-0001'),
    off('g1', 'OC-0003', { finish_id: 'G' }),                                   // not this project's group
    off('m1', 'OC-0010', { source_plan_id: 'cp1' }),                            // made by this project's plan, in stock
    off('m2', 'OC-0011', { source_plan_id: 'cp1', status: 'used', used_plan_id: 'cp9' }),
    off('m3', 'OC-0012', { source_plan_id: 'cp1', status: 'discarded' }),
    off('t1', 'OC-0009', { status: 'used', used_plan_id: 'cp1' }),              // taken by this project's plan
    off('u1', 'OC-0008', { status: 'used', used_plan_id: 'cp7' }),              // taken by another job
  ]
  it('use = other jobs\' offcuts in this project\'s groups (in stock or taken by its plan); made = what its plan made', () => {
    const t = offcutTabs({ offcuts, groupInfo, issuedPlanId: 'cp1' })
    expect(t.use.map(o => o.code)).toEqual(['OC-0001', 'OC-0002', 'OC-0009'])
    expect(t.made.map(o => o.code)).toEqual(['OC-0010', 'OC-0011', 'OC-0012'])
  })
  it('before issue nothing is "made", and the in-stock rows are the old table', () => {
    const t = offcutTabs({ offcuts, groupInfo, issuedPlanId: null })
    expect(t.made).toEqual([])
    expect(t.use.map(o => o.code)).toEqual(['OC-0001', 'OC-0002', 'OC-0010'])
  })
})

describe('offcutConsumer', () => {
  it('names the job and the items cut from a used offcut', () => {
    expect(offcutConsumer(off('m2', 'OC-0011', { status: 'used', used_plan_id: 'cp9' }), plans, projectNames))
      .toEqual({ projectName: 'HOSPITAL', issued_at: '2026-10-28T03:00:00Z', openings: ['T-01'] })
  })
  it('is null for an offcut that is not used', () => {
    expect(offcutConsumer(off('o1', 'OC-0001'), plans, projectNames)).toBeNull()
  })
  it('a consumer plan not loaded gives no names, never a crash', () => {
    expect(offcutConsumer(off('x', 'OC-0099', { status: 'used', used_plan_id: 'nope' }), plans, projectNames))
      .toEqual({ projectName: null, issued_at: null, openings: [] })
  })
})

describe('voidBlockers', () => {
  const offcuts = [
    off('m4', 'OC-0013', { source_plan_id: 'cp1', status: 'used', used_plan_id: 'cp9' }),
    off('m2', 'OC-0011', { source_plan_id: 'cp1', status: 'used', used_plan_id: 'cp9' }),
    off('m1', 'OC-0010', { source_plan_id: 'cp1' }),
    off('z1', 'OC-0001', { source_plan_id: 'cp2', status: 'used', used_plan_id: 'cp9' }),
  ]
  it('lists the used offcuts this plan made and each consuming plan once', () => {
    expect(voidBlockers({ offcuts, plans, planId: 'cp1', projectNames })).toEqual({
      codes: ['OC-0011', 'OC-0013'],
      consumers: [{ plan_id: 'cp9', projectName: 'HOSPITAL', issued_at: '2026-10-28T03:00:00Z' }],
    })
  })
  it('a consumer whose project is not visible still lists the codes, with no project name', () => {
    const b = voidBlockers({ offcuts: [off('m5', 'OC-0020', { source_plan_id: 'cp1', status: 'used', used_plan_id: 'cp8' })], plans, planId: 'cp1', projectNames })
    expect(b).toEqual({ codes: ['OC-0020'], consumers: [{ plan_id: 'cp8', projectName: null, issued_at: '2026-10-29T03:00:00Z' }] })
  })
  it('nothing used gives no codes', () => {
    expect(voidBlockers({ offcuts: [off('m1', 'OC-0010', { source_plan_id: 'cp1' })], plans, planId: 'cp1', projectNames })).toEqual({ codes: [], consumers: [] })
  })
})

describe('codesText', () => {
  it('lists up to 3 codes, then first … last', () => {
    expect(codesText(['OC-0002'])).toBe('OC-0002')
    expect(codesText(['OC-0002', 'OC-0003', 'OC-0006'])).toBe('OC-0002, OC-0003, OC-0006')
    expect(codesText(['OC-0002', 'OC-0003', 'OC-0006', 'OC-0007'])).toBe('OC-0002 … OC-0007')
    expect(codesText([])).toBe('')
  })
})

describe('cutErrorWithBlockers', () => {
  const offcuts = [off('m2', 'OC-0011', { source_plan_id: 'cp1', status: 'used', used_plan_id: 'cp9' })]
  const base = { offcuts, plans, planId: 'cp1', projectNames: { p9: 'HOSPITAL' } }
  it('the server refusal "used by another job" gets the codes and jobs', () => {
    const error = { action: 'void', message: 'เศษจากใบตัดนี้ถูกงานอื่นใช้ไปแล้ว ยกเลิกไม่ได้' }
    const v = cutErrorWithBlockers({ error, ...base })
    expect(v.message).toBe(error.message)
    expect(v.blockers.codes).toEqual(['OC-0011'])
    expect(v.blockers.consumers.map(c => c.projectName)).toEqual(['HOSPITAL'])
  })
  it('any other void failure stays the plain error, even when offcuts of the plan are used', () => {
    const error = { action: 'void', message: 'network down' }
    expect(cutErrorWithBlockers({ error, ...base })).toBe(error)
  })
  it('an issue error, no error, or no issued plan pass through unchanged', () => {
    const issue = { action: 'issue', message: 'เศษจากใบตัดนี้ถูกงานอื่นใช้ไปแล้ว' }
    expect(cutErrorWithBlockers({ error: issue, ...base })).toBe(issue)
    expect(cutErrorWithBlockers({ error: null, ...base })).toBeNull()
    const v = { action: 'void', message: 'เศษจากใบตัดนี้ถูกงานอื่นใช้ไปแล้ว ยกเลิกไม่ได้' }
    expect(cutErrorWithBlockers({ error: v, ...base, planId: null })).toBe(v)
  })
})

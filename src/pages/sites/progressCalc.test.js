import { describe, it, expect } from 'vitest'
import fixtures from './progressCalc.fixtures.json'
import { taskProgress, nodeProgress, unallocatedPoints, siteProgress } from './progressCalc.js'

describe('siteProgress matches the shared SQL fixtures', () => {
  fixtures.forEach((fx) => {
    it(fx.name, () => {
      const r = siteProgress({ phases: fx.phases, subtasks: fx.subtasks, tasks: fx.tasks, contractValue: fx.contract_value })
      expect(Object.keys(r.phasePct).sort()).toEqual(Object.keys(fx.expect.phases).sort())
      Object.entries(fx.expect.phases).forEach(([id, pct]) => expect(r.phasePct[id]).toBeCloseTo(pct, 2))
      expect(r.contractPct).toBeCloseTo(fx.expect.contract_pct, 2)
      if (fx.expect.total_pct == null) expect(r.totalPct).toBeNull()
      else expect(r.totalPct).toBeCloseTo(fx.expect.total_pct, 2)
    })
  })
})

describe('VO values from the admin-only table', () => {
  const fx = fixtures.find((f) => f.name === 'vo two numbers')
  const phasesNoField = fx.phases.map((p) => { const q = { ...p }; delete q.vo_value; return q })

  it('uses a voValues map instead of the phase field', () => {
    const r = siteProgress({ phases: phasesNoField, subtasks: [], tasks: fx.tasks, contractValue: 900000, voValues: { B: 100000 } })
    expect(r.totalPct).toBeCloseTo(90, 2)
  })

  it('returns totalPct null when VO values are not available (null)', () => {
    const r = siteProgress({ phases: phasesNoField, subtasks: [], tasks: fx.tasks, contractValue: 900000, voValues: null })
    expect(r.totalPct).toBeNull()
    expect(r.contractPct).toBeCloseTo(100, 2)
  })

  it('returns totalPct null without a contract value (PM rows)', () => {
    const r = siteProgress({ phases: fx.phases, subtasks: [], tasks: fx.tasks, contractValue: undefined })
    expect(r.totalPct).toBeNull()
  })
})

describe('unallocatedPoints', () => {
  it('is 100 minus the top-level points: 50 + 30 leaves 20', () => {
    expect(unallocatedPoints([{ id: 'a', weight_pts: 50 }, { id: 'b', weight_pts: 30 }])).toBeCloseTo(20, 2)
  })

  it('ignores issue cards and split children', () => {
    const tasks = [
      { id: 'a', weight_pts: 50 },
      { id: 'a1', parent_task_id: 'a', weight_pts: 50 },
      { id: 'i', weight_pts: 40, issue_report_id: 'R1' },
    ]
    expect(unallocatedPoints(tasks)).toBeCloseTo(50, 2)
  })

  it('does not go below 0 and handles 33.33 + 33.33 + 33.34', () => {
    expect(unallocatedPoints([{ weight_pts: 33.33 }, { weight_pts: 33.33 }, { weight_pts: 33.34 }])).toBe(0)
  })
})

describe('issue cards are ignored in node progress', () => {
  it('a done issue card adds nothing', () => {
    const tasks = [
      { id: 'a', phase_id: 'A', weight_pts: 50, status: 'not_started' },
      { id: 'i', phase_id: 'A', weight_pts: 50, status: 'done', issue_report_id: 'R1' },
    ]
    const p = nodeProgress('A', { tasksByNode: { A: tasks }, subtasksByParent: {}, nodeById: { A: { id: 'A', status: 'in_progress' } } })
    expect(p).toBe(0)
  })
})

describe('taskProgress', () => {
  it('caps a quantity card at 1', () => {
    expect(taskProgress({ id: 'q', progress_mode: 'quantity', planned_qty: 10, done_qty: 15 }, () => [])).toBe(1)
  })

  it('uses the mean of the children when the parent has 0 points', () => {
    const kids = [{ id: 'c1', weight_pts: 0, status: 'done' }, { id: 'c2', weight_pts: 0, status: 'not_started' }]
    expect(taskProgress({ id: 'p', weight_pts: 0 }, (id) => (id === 'p' ? kids : []))).toBeCloseTo(0.5, 5)
  })
})

describe('cards without weight_pts (old data) share 100 equally', () => {
  it('3 cards, 1 done -> 33.33%', () => {
    const tasks = [{ id: 'a', status: 'done' }, { id: 'b', status: 'in_progress' }, { id: 'c', status: 'not_started' }]
    const p = nodeProgress('A', { tasksByNode: { A: tasks }, subtasksByParent: {}, nodeById: {} })
    expect(p * 100).toBeCloseTo(33.33, 2)
    expect(unallocatedPoints(tasks)).toBe(0)
  })
})

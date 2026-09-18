import { describe, it, expect } from 'vitest'
import {
  groupSubtasksByParent, computeNodeStats, isLeaf, flattenLeaves,
  flattenVisibleRows, siblingWeightSum,
} from './subtaskCalc.js'

describe('groupSubtasksByParent', () => {
  it('groups direct children of a phase under the phase id', () => {
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null },
      { id: 's2', phase_id: 'p1', parent_subtask_id: null },
    ]
    const g = groupSubtasksByParent(subtasks)
    expect(g.p1.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('groups nested children under their parent subtask id, separately from the phase', () => {
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null },
      { id: 's1a', phase_id: 'p1', parent_subtask_id: 's1' },
    ]
    const g = groupSubtasksByParent(subtasks)
    expect(g.p1.map((s) => s.id)).toEqual(['s1'])
    expect(g.s1.map((s) => s.id)).toEqual(['s1a'])
  })
})

describe('isLeaf', () => {
  it('is true for a node with no entry in the parent map', () => {
    expect(isLeaf('p1', {})).toBe(true)
  })

  it('is false for a node that has child subtasks', () => {
    const g = groupSubtasksByParent([{ id: 's1', phase_id: 'p1', parent_subtask_id: null }])
    expect(isLeaf('p1', g)).toBe(false)
    expect(isLeaf('s1', g)).toBe(true)
  })
})

describe('computeNodeStats', () => {
  it('falls back to manual (source: manual) for a leaf with zero microtasks', () => {
    expect(computeNodeStats('p1', {}, {})).toEqual({
      total: 0, done: 0, pct: 0, derivedStatus: null, billingWeightPct: null, source: 'manual',
    })
  })

  it('derives from microtasks (source: microtasks) when a leaf has them, billingWeightPct stays null', () => {
    const microtasksByNodeId = { p1: [{ status: 'done' }, { status: 'in_progress' }] }
    expect(computeNodeStats('p1', {}, microtasksByNodeId)).toEqual({
      total: 2, done: 1, pct: 50, derivedStatus: 'in_progress', billingWeightPct: null, source: 'microtasks',
    })
  })

  it('derives from a single level of child subtasks, summing their weights', () => {
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 10 },
      { id: 's2', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 20 },
    ]
    const subtasksByParent = groupSubtasksByParent(subtasks)
    const microtasksByNodeId = { s1: [{ status: 'done' }], s2: [{ status: 'done' }] }
    const stats = computeNodeStats('p1', subtasksByParent, microtasksByNodeId)
    expect(stats).toEqual({ total: 2, done: 2, pct: 100, derivedStatus: 'done', billingWeightPct: 30, source: 'subtasks' })
  })

  it('recurses through a second level of nesting (worked example from the spec)', () => {
    // phase "ผลิต" (p1) has 2 child subtasks: "ตัดวัสดุ" (s1, done, weight 10)
    // and "เชื่อมประกอบ" (s2, weight 20) which itself has 1 child subtask
    // "เชื่อมชั้น 3" (s2a, done, weight 20).
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 10 },
      { id: 's2', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 20 },
      { id: 's2a', phase_id: 'p1', parent_subtask_id: 's2', billing_weight_pct: 20 },
    ]
    const subtasksByParent = groupSubtasksByParent(subtasks)
    const microtasksByNodeId = { s1: [{ status: 'done' }], s2a: [{ status: 'done' }] }

    const s2Stats = computeNodeStats('s2', subtasksByParent, microtasksByNodeId)
    expect(s2Stats).toEqual({ total: 1, done: 1, pct: 100, derivedStatus: 'done', billingWeightPct: 20, source: 'subtasks' })

    const p1Stats = computeNodeStats('p1', subtasksByParent, microtasksByNodeId)
    expect(p1Stats).toEqual({ total: 2, done: 2, pct: 100, derivedStatus: 'done', billingWeightPct: 30, source: 'subtasks' })
  })

  it('is in_progress when some but not all children are done, not_started when none have started', () => {
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 10 },
      { id: 's2', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 10 },
    ]
    const subtasksByParent = groupSubtasksByParent(subtasks)
    expect(computeNodeStats('p1', subtasksByParent, { s1: [{ status: 'done' }], s2: [{ status: 'not_started' }] }).derivedStatus).toBe('in_progress')
    expect(computeNodeStats('p1', subtasksByParent, {}).derivedStatus).toBe('not_started')
  })
})

describe('flattenLeaves', () => {
  it('returns a phase itself when it has no subtasks', () => {
    const phases = [{ id: 'p1' }, { id: 'p2' }]
    expect(flattenLeaves(phases, {}).map((n) => n.id)).toEqual(['p1', 'p2'])
  })

  it('returns leaf subtasks instead of a phase that has subtasks, at any depth', () => {
    const phases = [{ id: 'p1' }, { id: 'p2' }]
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null },
      { id: 's1a', phase_id: 'p1', parent_subtask_id: 's1' },
    ]
    const subtasksByParent = groupSubtasksByParent(subtasks)
    // p1 has a child (s1) so it's not a leaf; s1 has a child (s1a) so it's
    // not a leaf either; s1a has no children -> the only leaf under p1.
    // p2 has no subtasks -> it is itself a leaf.
    expect(flattenLeaves(phases, subtasksByParent).map((n) => n.id)).toEqual(['s1a', 'p2'])
  })
})

describe('flattenVisibleRows', () => {
  const phases = [{ id: 'p1' }, { id: 'p2' }]
  const subtasks = [
    { id: 's1', phase_id: 'p1', parent_subtask_id: null },
    { id: 's1a', phase_id: 'p1', parent_subtask_id: 's1' },
  ]
  const subtasksByParent = groupSubtasksByParent(subtasks)

  it('shows only phases when nothing is expanded', () => {
    const rows = flattenVisibleRows(phases, subtasksByParent, new Set())
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([['p1', 0], ['p2', 0]])
  })

  it('reveals depth-1 children when their phase is expanded, without revealing depth-2 yet', () => {
    const rows = flattenVisibleRows(phases, subtasksByParent, new Set(['p1']))
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([['p1', 0], ['s1', 1], ['p2', 0]])
  })

  it('reveals depth-2 children only once both ancestors are expanded', () => {
    const rows = flattenVisibleRows(phases, subtasksByParent, new Set(['p1', 's1']))
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([['p1', 0], ['s1', 1], ['s1a', 2], ['p2', 0]])
  })
})

describe('siblingWeightSum', () => {
  const subtasks = [
    { id: 's1', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 30 },
    { id: 's2', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 40 },
  ]
  const subtasksByParent = groupSubtasksByParent(subtasks)

  it('sums every sibling under a parent', () => {
    expect(siblingWeightSum('p1', subtasksByParent)).toBe(70)
  })

  it('excludes the subtask being edited, so re-saving it at its own weight does not double-count', () => {
    expect(siblingWeightSum('p1', subtasksByParent, 's1')).toBe(40)
  })

  it('is 0 for a parent with no children yet', () => {
    expect(siblingWeightSum('nonexistent', subtasksByParent)).toBe(0)
  })
})

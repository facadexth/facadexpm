import { describe, it, expect } from 'vitest'
import { computePhaseTaskStats, pickActivePhase, isTaskOverdue } from './phaseTasksCalc.js'

describe('computePhaseTaskStats', () => {
  it('returns derivedStatus null for a phase with zero tasks', () => {
    expect(computePhaseTaskStats([])).toEqual({ total: 0, done: 0, pct: 0, derivedStatus: null })
  })

  it('returns done when every task is done', () => {
    const tasks = [{ status: 'done' }, { status: 'done' }]
    expect(computePhaseTaskStats(tasks)).toEqual({ total: 2, done: 2, pct: 100, derivedStatus: 'done' })
  })

  it('returns in_progress with the correct done/total/pct when some but not all are done', () => {
    const tasks = [{ status: 'done' }, { status: 'done' }, { status: 'done' }, { status: 'in_progress' }, { status: 'not_started' }]
    expect(computePhaseTaskStats(tasks)).toEqual({ total: 5, done: 3, pct: 60, derivedStatus: 'in_progress' })
  })

  it('returns in_progress when a task has started even with zero done', () => {
    const tasks = [{ status: 'in_progress' }, { status: 'not_started' }]
    expect(computePhaseTaskStats(tasks).derivedStatus).toBe('in_progress')
  })

  it('returns not_started when every task is still not_started', () => {
    const tasks = [{ status: 'not_started' }, { status: 'not_started' }]
    expect(computePhaseTaskStats(tasks).derivedStatus).toBe('not_started')
  })
})

describe('pickActivePhase', () => {
  const phases = [
    { id: 'p1', sort_order: 1 },
    { id: 'p2', sort_order: 2 },
    { id: 'p3', sort_order: 3 },
  ]

  it('returns null when no phase has any tasks', () => {
    expect(pickActivePhase(phases, {})).toBeNull()
  })

  it('picks the earliest in_progress phase over a later not_started one', () => {
    const tasksByPhaseId = {
      p1: [{ status: 'done' }],
      p2: [{ status: 'in_progress' }],
      p3: [{ status: 'not_started' }],
    }
    expect(pickActivePhase(phases, tasksByPhaseId).id).toBe('p2')
  })

  it('falls back to the earliest not_started phase when none are in_progress', () => {
    const tasksByPhaseId = {
      p1: [{ status: 'done' }],
      p3: [{ status: 'not_started' }],
    }
    expect(pickActivePhase(phases, tasksByPhaseId).id).toBe('p3')
  })

  it('skips phases with zero tasks entirely, even if earlier by sort_order', () => {
    const tasksByPhaseId = {
      p3: [{ status: 'in_progress' }],
    }
    expect(pickActivePhase(phases, tasksByPhaseId).id).toBe('p3')
  })
})

describe('isTaskOverdue', () => {
  it('is true for a past due_date on a task that is not done', () => {
    expect(isTaskOverdue({ due_date: '2026-09-01', status: 'in_progress' }, '2026-09-17')).toBe(true)
  })

  it('is false once the task is done, even past its due_date', () => {
    expect(isTaskOverdue({ due_date: '2026-09-01', status: 'done' }, '2026-09-17')).toBe(false)
  })

  it('is false when due_date is null', () => {
    expect(isTaskOverdue({ due_date: null, status: 'not_started' }, '2026-09-17')).toBe(false)
  })

  it('is false when due_date is today or in the future', () => {
    expect(isTaskOverdue({ due_date: '2026-09-17', status: 'not_started' }, '2026-09-17')).toBe(false)
    expect(isTaskOverdue({ due_date: '2026-09-18', status: 'not_started' }, '2026-09-17')).toBe(false)
  })
})

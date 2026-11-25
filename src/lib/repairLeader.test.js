import { describe, it, expect } from 'vitest'
import { suggestLeader } from './repairLeader.js'

describe('suggestLeader', () => {
  it('picks the worker with the most distinct leader days (two shifts on one day count once)', () => {
    const rows = [
      { worker_id: 'a', date: '2026-10-01' }, { worker_id: 'a', date: '2026-10-01' },
      { worker_id: 'b', date: '2026-10-02' }, { worker_id: 'b', date: '2026-10-03' },
    ]
    expect(suggestLeader(rows)).toEqual({ workerId: 'b', days: 2 })
  })
  it('a tie goes to the most recent leader', () => {
    const rows = [{ worker_id: 'a', date: '2026-10-05' }, { worker_id: 'b', date: '2026-10-09' }]
    expect(suggestLeader(rows)).toEqual({ workerId: 'b', days: 1 })
  })
  it('skips workers no longer active', () => {
    const rows = [{ worker_id: 'a', date: '2026-10-01' }, { worker_id: 'a', date: '2026-10-02' }, { worker_id: 'b', date: '2026-10-03' }]
    expect(suggestLeader(rows, ['b'])).toEqual({ workerId: 'b', days: 1 })
  })
  it('no history -> null', () => {
    expect(suggestLeader([])).toBe(null)
    expect(suggestLeader(null, ['a'])).toBe(null)
    expect(suggestLeader([{ worker_id: 'a', date: '2026-10-01' }], [])).toBe(null)
  })
})
